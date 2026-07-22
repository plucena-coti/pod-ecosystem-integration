import type { Address, Hex, PublicClient } from "viem";
import { encodeEventTopics, parseAbiItem, pad } from "viem";

/** Block-explorer API descriptor used for verification status checks. */
type ExplorerApi = {
  /** Etherscan-compatible (`?module=contract&action=getsourcecode`) or Blockscout. */
  kind: "etherscan" | "blockscout";
  /** Base API URL (may already contain a query string). */
  apiUrl: string;
  /** Human-facing explorer base URL. */
  siteUrl: string;
  /** Optional API key (Etherscan family). */
  apiKey?: string;
};

/** Resolve the explorer API for a chain id, or undefined if none is configured. */
export const explorerApiForChain = (chainId: number): ExplorerApi | undefined => {
  switch (chainId) {
    case 11155111:
      return {
        kind: "etherscan",
        apiUrl: "https://api.etherscan.io/v2/api?chainid=11155111",
        siteUrl: "https://sepolia.etherscan.io",
        apiKey: process.env.ETHERSCAN_API_KEY,
      };
    case 43113:
      return {
        kind: "etherscan",
        // Fuji has no Blockscout; Snowscan is routed via Etherscan V2.
        apiUrl: "https://api.etherscan.io/v2/api?chainid=43113",
        siteUrl: "https://testnet.snowscan.xyz",
        apiKey: process.env.ETHERSCAN_API_KEY,
      };
    case 7082400:
      return {
        kind: "blockscout",
        apiUrl: "https://testnet.cotiscan.io/api",
        siteUrl: "https://testnet.cotiscan.io",
      };
    default:
      return undefined;
  }
};

/** Explorer address page URL, or undefined when no explorer is configured. */
export const explorerAddressUrl = (chainId: number, address: Address): string | undefined => {
  const api = explorerApiForChain(chainId);
  return api ? `${api.siteUrl}/address/${address}` : undefined;
};

/** True if `address` has deployed bytecode on-chain (read-only). */
export const hasOnChainCode = async (
  publicClient: PublicClient,
  address: Address
): Promise<boolean> => {
  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== "0x");
};

/**
 * Best-effort: is the contract source verified on the chain's explorer?
 * Returns `true`/`false`, or `undefined` when the explorer is unknown or the query fails
 * (so callers can render "unknown" rather than a false negative). Read-only HTTP GET.
 */
export const isVerifiedOnExplorer = async (
  chainId: number,
  address: Address
): Promise<boolean | undefined> => {
  const api = explorerApiForChain(chainId);
  if (!api) return undefined;

  const params = new URLSearchParams({
    module: "contract",
    action: "getsourcecode",
    address,
  });
  if (api.apiKey) params.set("apikey", api.apiKey);
  const sep = api.apiUrl.includes("?") ? "&" : "?";

  try {
    const res = await fetch(`${api.apiUrl}${sep}${params.toString()}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const json: any = await res.json();
    const result = Array.isArray(json?.result) ? json.result[0] : json?.result;
    if (!result) return undefined;
    // Etherscan returns SourceCode (empty string when unverified); Blockscout uses SourceCode too,
    // some variants use `source_code` / `is_verified`.
    if (typeof result.is_verified === "boolean") return result.is_verified;
    const src: unknown = result.SourceCode ?? result.source_code ?? "";
    return typeof src === "string" && src.trim().length > 0;
  } catch {
    return undefined;
  }
};

const TOKEN_REGISTRATION_REQUESTED = parseAbiItem(
  "event TokenRegistrationRequested(address indexed pToken, bytes32 indexed requestId)"
);

/**
 * Fetch `TokenRegistrationRequested` logs via Etherscan-family API (Snowscan for Fuji).
 * Prefer this over eth_getLogs on public Fuji RPCs, which often reject / rate-limit range queries.
 */
export const findTokenRegistrationRequestIdsViaExplorer = async (params: {
  chainId: number;
  factory: Address;
  pToken: Address;
  fromBlock?: bigint | number;
  toBlock?: bigint | number | "latest";
}): Promise<`0x${string}`[]> => {
  const api = explorerApiForChain(params.chainId);
  if (!api || api.kind !== "etherscan") return [];

  const [topic0] = encodeEventTopics({
    abi: [TOKEN_REGISTRATION_REQUESTED],
    eventName: "TokenRegistrationRequested",
  });
  const topic1 = pad(params.pToken.toLowerCase() as Hex, { size: 32 });

  const query = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    address: params.factory,
    topic0: topic0 as string,
    topic0_1_opr: "and",
    topic1,
    fromBlock: String(params.fromBlock ?? 0),
    toBlock: String(params.toBlock ?? "latest"),
  });
  if (api.apiKey) query.set("apikey", api.apiKey);
  const sep = api.apiUrl.includes("?") ? "&" : "?";

  const res = await fetch(`${api.apiUrl}${sep}${query.toString()}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`explorer getLogs HTTP ${res.status}`);
  }
  const json: any = await res.json();
  if (json?.status === "0" && typeof json?.result === "string") {
    // Etherscan uses status=0 for "No records found" and for errors.
    if (/no record|no logs|result not found/i.test(json.result)) return [];
    throw new Error(`explorer getLogs: ${json.result}`);
  }
  const rows: any[] = Array.isArray(json?.result) ? json.result : [];
  const ids: `0x${string}`[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const topics: string[] = row.topics ?? [];
    const requestId = (topics[2] ?? undefined) as `0x${string}` | undefined;
    if (!requestId || seen.has(requestId.toLowerCase())) continue;
    seen.add(requestId.toLowerCase());
    ids.push(requestId);
  }
  return ids.reverse();
};
