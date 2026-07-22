import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  getChainConfig,
  getViemClients,
  optionalEnv,
  readDeployConfig,
  resolveDeployerAddress,
  resolvePortalOracle,
  resolveWalletAccount,
  waitMined,
  ensureGasFunds,
  oracleTokensForChain,
} from "../deploy-utils.js";
import { encodeFunctionData, encodeEventTopics, parseAbiItem, zeroAddress, type Address } from "viem";

export type ConnectedNetwork = {
  viem: any;
  chainId: number;
  chainName: string;
  publicClient: any;
  walletClient: any;
  deployer: `0x${string}`;
};

export type SourceFactoryDeployment = {
  portalImplementation: `0x${string}`;
  podTokenImplementation: `0x${string}`;
  factory: `0x${string}`;
};

export type CotiMotherDeployment = {
  mother: `0x${string}`;
};

export type SourcePortalDeployment = {
  portal: `0x${string}`;
  pToken: `0x${string}`;
};

export const DEFAULT_SOURCE_NETWORK = "sepolia";
export const DEFAULT_COTI_NETWORK = "cotiTestnet";

export const connectPrivacyPortalNetwork = async (networkName?: string): Promise<ConnectedNetwork> => {
  const connection = await network.connect(networkName ? { network: networkName } : undefined);
  const { viem, provider, networkName: hardhatNetworkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    hardhatNetworkName
  );
  const deployer = await resolveDeployerAddress(walletClient);
  console.log(`[privacyPortal] connected network=${chainName} chainId=${chainId} deployer=${deployer}`);
  return { viem, chainId, chainName, publicClient, walletClient, deployer };
};

export const envAddress = (key: string): `0x${string}` => asAddress(process.env[key] ?? "", key);

export const optionalEnvAddress = (key: string): `0x${string}` | undefined => {
  const value = optionalEnv(key);
  return value ? asAddress(value, key) : undefined;
};

export const envBigInt = (key: string, fallback?: bigint): bigint => {
  const value = optionalEnv(key);
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return BigInt(value);
};

export const envString = (key: string, fallback?: string): string => {
  const value = optionalEnv(key);
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const getInboxFromConfig = async (ctx: ConnectedNetwork, label: string): Promise<`0x${string}`> => {
  const configured = optionalEnvAddress(`${label.toUpperCase()}_INBOX`) ?? optionalEnvAddress("INBOX");
  if (configured) return configured;

  const deployConfig = await readDeployConfig();
  const chainConfig = getChainConfig(deployConfig, ctx.chainId, label);
  return asAddress(chainConfig.inbox ?? "", `deployConfig.chains.${ctx.chainId}.inbox`);
};

export const getCotiMotherFromConfig = async (ctx: ConnectedNetwork): Promise<`0x${string}`> => {
  const configured = optionalEnvAddress("COTI_MOTHER");
  if (configured) return configured;

  const deployConfig = await readDeployConfig();
  const chainConfig = getChainConfig(deployConfig, ctx.chainId, "coti");
  return asAddress(chainConfig.cotiMother ?? "", `deployConfig.chains.${ctx.chainId}.cotiMother`);
};

export const deployCotiMother = async (
  ctx: ConnectedNetwork,
  params: { inbox: `0x${string}`; owner?: `0x${string}` }
): Promise<CotiMotherDeployment> => {
  const owner = params.owner ?? ctx.deployer;
  console.log("[privacyPortal] deploying PodErc20CotiMother...");
  const mother = await ctx.viem.deployContract("PodErc20CotiMother", [params.inbox, owner], {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(`[privacyPortal] PodErc20CotiMother=${mother.address}`);
  await logDeployment(ctx, "PodErc20CotiMother", mother.address);
  return { mother: mother.address };
};

export const allowlistFactoryOnMother = async (
  ctx: ConnectedNetwork,
  params: { mother: `0x${string}`; sourceChainId: bigint; factory: `0x${string}` }
) => {
  const mother = await ctx.viem.getContractAt("PodErc20CotiMother", params.mother, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  const allowed = await mother.read.allowedFactories([params.sourceChainId, params.factory]);
  if (allowed) {
    console.log(
      `[privacyPortal] factory already allowlisted on mother chain=${params.sourceChainId} factory=${params.factory}`
    );
    return;
  }
  console.log(
    `[privacyPortal] allowlisting factory on mother chain=${params.sourceChainId} factory=${params.factory}...`
  );
  const motherOwner = (await mother.read.owner()) as `0x${string}`;
  const signer = await resolveWalletAccount(ctx.walletClient, motherOwner);
  const hash = await mother.write.setAllowedFactory([params.sourceChainId, params.factory, true], {
    account: signer,
    gas: await ensureGasFunds({
      publicClient: ctx.publicClient,
      account: signer,
      to: params.mother,
      data: encodeFunctionData({
        abi: mother.abi,
        functionName: "setAllowedFactory",
        args: [params.sourceChainId, params.factory, true],
      }),
      label: `mother owner ${signer}`,
    }),
  });
  await waitMined(ctx.publicClient, hash);
  console.log("[privacyPortal] factory allowlisted on mother");
};

export const deploySourceFactory = async (
  ctx: ConnectedNetwork,
  params: {
    inbox: `0x${string}`;
    cotiChainId: bigint;
    cotiMother: `0x${string}`;
    owner?: `0x${string}`;
    feeRecipient?: `0x${string}`;
    rescueRecipient?: `0x${string}`;
    priceOracle?: `0x${string}`;
    depositFixedFee?: bigint;
    depositPercentageBps?: bigint;
    depositMaxFee?: bigint;
    withdrawFixedFee?: bigint;
    withdrawPercentageBps?: bigint;
    withdrawMaxFee?: bigint;
  }
): Promise<SourceFactoryDeployment> => {
  const owner = params.owner ?? ctx.deployer;
  const feeRecipient = params.feeRecipient ?? owner;
  const rescueRecipient = params.rescueRecipient ?? feeRecipient;
  const maxFee = (1n << 128n) - 1n;
  const deployConfig = await readDeployConfig();
  const chainConfig = getChainConfig(deployConfig, ctx.chainId, "source");
  const priceOracle =
    params.priceOracle ??
    (resolvePortalOracle(chainConfig) as `0x${string}` | undefined);
  console.log("[privacyPortal] deploying PrivacyPortal implementation...");
  const portalImplementation = await ctx.viem.deployContract("PrivacyPortal", [], {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(`[privacyPortal] PrivacyPortal implementation=${portalImplementation.address}`);

  console.log("[privacyPortal] deploying PodErc20MintableInitializable implementation...");
  const podTokenImplementation = await ctx.viem.deployContract("PodErc20MintableInitializable", [], {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(`[privacyPortal] PodErc20MintableInitializable implementation=${podTokenImplementation.address}`);

  console.log("[privacyPortal] deploying PrivacyPortalFactory...");
  const { portalNative } = oracleTokensForChain(ctx.chainId);
  const factory = await ctx.viem.deployContract(
    "PrivacyPortalFactory",
    [
      owner,
      params.inbox,
      params.cotiChainId,
      params.cotiMother,
      podTokenImplementation.address,
      portalImplementation.address,
      feeRecipient,
      rescueRecipient,
      portalNative,
      params.priceOracle ?? priceOracle ?? zeroAddress,
      params.depositFixedFee ?? 0n,
      params.depositPercentageBps ?? 0n,
      params.depositMaxFee ?? maxFee,
      params.withdrawFixedFee ?? 0n,
      params.withdrawPercentageBps ?? 0n,
      params.withdrawMaxFee ?? maxFee,
    ],
    { client: { public: ctx.publicClient, wallet: ctx.walletClient } }
  );
  console.log(`[privacyPortal] PrivacyPortalFactory=${factory.address}`);

  await logDeployment(ctx, "PrivacyPortal", portalImplementation.address);
  await logDeployment(ctx, "PodErc20MintableInitializable", podTokenImplementation.address);
  await logDeployment(ctx, "PrivacyPortalFactory", factory.address);

  return {
    portalImplementation: portalImplementation.address,
    podTokenImplementation: podTokenImplementation.address,
    factory: factory.address,
  };
};

export const createSourcePortalAndPToken = async (
  ctx: ConnectedNetwork,
  params: {
    factory: `0x${string}`;
    underlying: `0x${string}`;
    name: string;
    symbol: string;
    decimals?: number;
    nativeWrappedUnderlying?: boolean;
    cotiCtx?: ConnectedNetwork;
    cotiMother?: `0x${string}`;
    cotiChainId?: bigint;
  }
): Promise<SourcePortalDeployment> => {
  const decimals = params.decimals ?? 18;
  const factory = await ctx.viem.getContractAt("PrivacyPortalFactory", params.factory, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });

  console.log(`[privacyPortal] creating portal pair underlying=${params.underlying}...`);
  const hash = await factory.write.createPortal(
    [params.underlying, params.name, params.symbol, decimals, params.nativeWrappedUnderlying ?? false],
    { account: ctx.deployer, value: 2_500_000_000_000n }
  );
  await waitMined(ctx.publicClient, hash);

  const portal = await factory.read.portalForUnderlying([params.underlying]);
  const pToken = await factory.read.pTokenForUnderlying([params.underlying]);
  console.log(`[privacyPortal] PrivacyPortal=${portal}`);
  console.log(`[privacyPortal] PoD pToken=${pToken}`);

  const portalContract = await ctx.viem.getContractAt("PrivacyPortal", portal, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  const [depositPortalFee] = await portalContract.read.estimateDepositFees([1n]);
  const [withdrawPortalFee] = await portalContract.read.estimateWithdrawFees([1n]);
  console.log(`[privacyPortal] estimateDepositPortalFee(1)=${depositPortalFee}`);
  console.log(`[privacyPortal] estimateWithdrawPortalFee(1)=${withdrawPortalFee}`);

  if (params.cotiMother && params.cotiCtx) {
    await waitForMotherRegistration({
      cotiCtx: params.cotiCtx,
      mother: params.cotiMother,
      sourceChainId: BigInt(ctx.chainId),
      pToken,
      timeoutMs: 120_000,
    });
  }

  await logDeployment(ctx, "PrivacyPortal", portal);
  await logDeployment(ctx, "PodErc20Mintable", pToken);
  return { portal, pToken };
};

export const waitForMotherRegistration = async (params: {
  cotiCtx: ConnectedNetwork;
  mother: `0x${string}`;
  sourceChainId: bigint;
  pToken: `0x${string}`;
  timeoutMs?: number;
  pollMs?: number;
}) => {
  const mother = await params.cotiCtx.viem.getContractAt("PodErc20CotiMother", params.mother, {
    client: { public: params.cotiCtx.publicClient, wallet: params.cotiCtx.walletClient },
  });
  const deadline = Date.now() + (params.timeoutMs ?? 120_000);
  const pollMs = params.pollMs ?? 3_000;

  while (Date.now() < deadline) {
    const registered = await mother.read.isRegistered([params.sourceChainId, params.pToken]);
    if (registered) {
      console.log(
        `[privacyPortal] pToken registered on mother chain=${params.sourceChainId} pToken=${params.pToken}`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out waiting for mother registration chain=${params.sourceChainId} pToken=${params.pToken}`
  );
};

const TOKEN_REGISTRATION_REQUESTED = parseAbiItem(
  "event TokenRegistrationRequested(address indexed pToken, bytes32 indexed requestId)"
);

/** Extract registration requestId from a factory `createPortal` (or similar) receipt. */
export const registrationRequestIdFromReceipt = (
  receipt: { logs?: readonly any[] },
  pToken?: Address
): `0x${string}` | undefined => {
  const [topic0] = encodeEventTopics({
    abi: [TOKEN_REGISTRATION_REQUESTED],
    eventName: "TokenRegistrationRequested",
  });

  for (const log of receipt.logs ?? []) {
    try {
      const decodedRequestId = log.args?.requestId as `0x${string}` | undefined;
      const decodedPToken = log.args?.pToken as Address | undefined;
      if (decodedRequestId) {
        if (pToken && decodedPToken && decodedPToken.toLowerCase() !== pToken.toLowerCase()) continue;
        return decodedRequestId;
      }
      const topics: string[] = log.topics ?? [];
      // topic0 = event sig; topic1 = pToken; topic2 = requestId
      if (topics.length < 3) continue;
      if (topics[0]?.toLowerCase() !== topic0.toLowerCase()) continue;
      if (pToken) {
        const topicPToken = `0x${topics[1].slice(-40)}`.toLowerCase();
        if (topicPToken !== pToken.toLowerCase()) continue;
      }
      return topics[2] as `0x${string}`;
    } catch {
      // continue
    }
  }
  return undefined;
};

/** Sepolia public RPCs often allow 10k; Fuji publicnode frequently rejects large eth_getLogs. */
const LOG_BLOCK_CHUNK_DEFAULT = 10_000n;
const LOG_BLOCK_CHUNK_FUJI = 2_000n;
/** Cap RPC log walk so a flaky Fuji RPC cannot spin forever. */
const LOG_RPC_LOOKBACK_BLOCKS = 50_000n;
/** How many recent outbound nonces to scan on the source inbox. */
const INBOX_REGISTRATION_NONCE_LOOKBACK = 64n;

const ERROR_CODE_EXECUTION_FAILED = 1n;

const packRequestId = (sourceChainId: bigint, targetChainId: bigint, nonce: bigint): `0x${string}` => {
  const packed =
    (sourceChainId << 192n) | (targetChainId << 128n) | (nonce & ((1n << 128n) - 1n));
  return `0x${packed.toString(16).padStart(64, "0")}` as `0x${string}`;
};

const addressInMethodCallData = (data: unknown, address: Address): boolean => {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 2 + 8 + 64) return false;
  const word = data.slice(10, 74).toLowerCase(); // first ABI word after selector
  const needle = address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return word === needle;
};

/** Prefer stored / explorer / inbox scan — avoid flaky Fuji public RPC eth_getLogs. */
export const findMotherRegistrationRequestIds = async (params: {
  publicClient: any;
  chainId: number;
  factory: Address;
  pToken: Address;
  sourceInbox?: Address;
  cotiChainId?: number;
  knownRequestIds?: readonly `0x${string}`[];
}): Promise<`0x${string}`[]> => {
  const seen = new Set<string>();
  const ids: `0x${string}`[] = [];
  const push = (requestId: `0x${string}` | undefined) => {
    if (!requestId || seen.has(requestId.toLowerCase())) return;
    seen.add(requestId.toLowerCase());
    ids.push(requestId);
  };

  for (const id of params.knownRequestIds ?? []) push(id);
  if (ids.length > 0) return ids;

  try {
    const { findTokenRegistrationRequestIdsViaExplorer } = await import("../explorer.js");
    const viaExplorer = await findTokenRegistrationRequestIdsViaExplorer({
      chainId: params.chainId,
      factory: params.factory,
      pToken: params.pToken,
    });
    for (const id of viaExplorer) push(id);
    if (ids.length > 0) {
      console.log(
        `[privacyPortal] found ${ids.length} TokenRegistrationRequested via explorer (chain ${params.chainId})`
      );
      return ids;
    }
  } catch (err) {
    console.warn(
      `[privacyPortal] explorer TokenRegistrationRequested lookup failed:`,
      err instanceof Error ? err.message : err
    );
  }

  if (params.sourceInbox && params.cotiChainId) {
    try {
      const viaInbox = await findRegistrationRequestIdsViaInbox({
        publicClient: params.publicClient,
        sourceInbox: params.sourceInbox,
        factory: params.factory,
        pToken: params.pToken,
        sourceChainId: BigInt(params.chainId),
        cotiChainId: BigInt(params.cotiChainId),
      });
      for (const id of viaInbox) push(id);
      if (ids.length > 0) {
        console.log(
          `[privacyPortal] found ${ids.length} registration requestId(s) via source inbox scan`
        );
        return ids;
      }
    } catch (err) {
      console.warn(
        `[privacyPortal] inbox registration scan failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Last resort: short RPC lookback (public Fuji often fails here).
  const chunk =
    params.chainId === 43113 ? LOG_BLOCK_CHUNK_FUJI : LOG_BLOCK_CHUNK_DEFAULT;
  const latest = await params.publicClient.getBlockNumber();
  const floor = latest > LOG_RPC_LOOKBACK_BLOCKS ? latest - LOG_RPC_LOOKBACK_BLOCKS : 0n;
  let oldestFoundBlock = latest + 1n;

  for (let toBlock = latest; toBlock >= floor; ) {
    const fromBlock = toBlock >= chunk - 1n ? toBlock - (chunk - 1n) : floor;
    try {
      const logs = await params.publicClient.getLogs({
        address: params.factory,
        event: TOKEN_REGISTRATION_REQUESTED,
        args: { pToken: params.pToken },
        fromBlock,
        toBlock,
      });
      for (const log of logs) {
        const requestId = (log.args?.requestId ?? log.topics?.[2]) as `0x${string}` | undefined;
        push(requestId);
        const block = BigInt(log.blockNumber ?? 0);
        if (block < oldestFoundBlock) oldestFoundBlock = block;
      }
      if (ids.length > 0 && fromBlock + 20_000n < oldestFoundBlock) break;
    } catch (err) {
      console.warn(
        `[privacyPortal] getLogs TokenRegistrationRequested failed ${fromBlock}..${toBlock}:`,
        err instanceof Error ? err.message : err
      );
      // On Fuji, bail after first failures instead of walking 50k blocks of errors.
      if (params.chainId === 43113) break;
    }
    if (fromBlock === floor) break;
    toBlock = fromBlock - 1n;
  }

  return ids.reverse();
};

const findRegistrationRequestIdsViaInbox = async (params: {
  publicClient: any;
  sourceInbox: Address;
  factory: Address;
  pToken: Address;
  sourceChainId: bigint;
  cotiChainId: bigint;
}): Promise<`0x${string}`[]> => {
  const inboxAbi = [
    {
      type: "function",
      name: "getRequestsLen",
      stateMutability: "view",
      inputs: [{ name: "targetChainId", type: "uint256" }],
      outputs: [{ type: "uint256" }],
    },
    {
      type: "function",
      name: "requests",
      stateMutability: "view",
      inputs: [{ name: "requestId", type: "bytes32" }],
      outputs: [
        { name: "requestId", type: "bytes32" },
        { name: "targetChainId", type: "uint256" },
        { name: "targetContract", type: "address" },
        {
          name: "methodCall",
          type: "tuple",
          components: [
            { name: "selector", type: "bytes4" },
            { name: "data", type: "bytes" },
            { name: "datatypes", type: "bytes8[]" },
            { name: "datalens", type: "bytes32[]" },
          ],
        },
        { name: "callerContract", type: "address" },
        { name: "originalSender", type: "address" },
        { name: "timestamp", type: "uint64" },
        { name: "callbackSelector", type: "bytes4" },
        { name: "errorSelector", type: "bytes4" },
        { name: "isTwoWay", type: "bool" },
        { name: "executed", type: "bool" },
        { name: "sourceRequestId", type: "bytes32" },
        { name: "targetFee", type: "uint256" },
        { name: "callerFee", type: "uint256" },
      ],
    },
  ] as const;

  const len = BigInt(
    await params.publicClient.readContract({
      address: params.sourceInbox,
      abi: inboxAbi,
      functionName: "getRequestsLen",
      args: [params.cotiChainId],
    })
  );
  if (len === 0n) return [];

  const start = len > INBOX_REGISTRATION_NONCE_LOOKBACK ? len - INBOX_REGISTRATION_NONCE_LOOKBACK + 1n : 1n;
  const factoryLc = params.factory.toLowerCase();
  const ids: `0x${string}`[] = [];

  for (let nonce = len; nonce >= start; nonce--) {
    const requestId = packRequestId(params.sourceChainId, params.cotiChainId, nonce);
    const req = await params.publicClient.readContract({
      address: params.sourceInbox,
      abi: inboxAbi,
      functionName: "requests",
      args: [requestId],
    });
    const originalSender = (req?.originalSender ?? req?.[5]) as Address | undefined;
    const methodCall = req?.methodCall ?? req?.[3];
    const data = methodCall?.data ?? methodCall?.[1];
    if (!originalSender || originalSender.toLowerCase() !== factoryLc) continue;
    if (!addressInMethodCallData(data, params.pToken)) continue;
    ids.push(requestId);
  }
  return ids;
};

/**
 * Ensure a source pToken is registered on the COTI mother after the factory was allowlisted.
 *
 * Uses only permissionless inbox retry (no `batchProcessRequests`):
 * 1. No-op if already registered.
 * 2. For each prior `TokenRegistrationRequested` id with COTI `errors[id].errorCode == 1`,
 *    call `retryFailedRequest` (anyone can pay gas).
 */
export const ensureMotherRegistration = async (params: {
  source: ConnectedNetwork;
  coti: ConnectedNetwork;
  factory: Address;
  mother: Address;
  sourceInbox: Address;
  cotiInbox: Address;
  pToken: Address;
  label?: string;
  knownRequestIds?: readonly `0x${string}`[];
}): Promise<"already" | "retried"> => {
  const label = params.label ?? params.pToken;
  const mother = await params.coti.viem.getContractAt("PodErc20CotiMother", params.mother, {
    client: { public: params.coti.publicClient, wallet: params.coti.walletClient },
  });
  if (await mother.read.isRegistered([BigInt(params.source.chainId), params.pToken])) {
    console.log(`[privacyPortal] ${label}: already registered on mother`);
    return "already";
  }

  const factoryAllowed = await mother.read.allowedFactories([
    BigInt(params.source.chainId),
    params.factory,
  ]);
  if (!factoryAllowed) {
    throw new Error(
      `${label}: factory ${params.factory} is not allowlisted on mother for chain ${params.source.chainId}. ` +
        `Run PpMotherAllow on COTI first.`
    );
  }

  const cotiInbox = await params.coti.viem.getContractAt("Inbox", params.cotiInbox, {
    client: { public: params.coti.publicClient, wallet: params.coti.walletClient },
  });

  const requestIds = await findMotherRegistrationRequestIds({
    publicClient: params.source.publicClient,
    chainId: params.source.chainId,
    factory: params.factory,
    pToken: params.pToken,
    sourceInbox: params.sourceInbox,
    cotiChainId: params.coti.chainId,
    knownRequestIds: params.knownRequestIds,
  });
  console.log(
    `[privacyPortal] ${label}: found ${requestIds.length} TokenRegistrationRequested id(s)`
  );

  for (const requestId of requestIds) {
    const err = await cotiInbox.read.errors([requestId]);
    const errCode = BigInt(err?.errorCode ?? err?.[1] ?? 0);
    const errId = (err?.requestId ?? err?.[0]) as `0x${string}` | undefined;
    const hasErr =
      !!errId &&
      errId !== "0x0000000000000000000000000000000000000000000000000000000000000000";

    if (!hasErr || errCode !== ERROR_CODE_EXECUTION_FAILED) {
      const incoming = await cotiInbox.read.incomingRequests([requestId]);
      const incomingId = (incoming?.requestId ?? incoming?.[0]) as `0x${string}` | undefined;
      const hasIncoming =
        !!incomingId &&
        incomingId !== "0x0000000000000000000000000000000000000000000000000000000000000000";
      if (!hasIncoming) {
        console.log(
          `[privacyPortal] ${label}: ${requestId} not yet on COTI inbox (wait for miner; do not batchProcess here)`
        );
      } else if (hasErr) {
        console.log(
          `[privacyPortal] ${label}: request ${requestId} has errorCode=${errCode} (not retryable as execution-failed)`
        );
      } else {
        console.log(
          `[privacyPortal] ${label}: request ${requestId} on COTI with no stored execution error; waiting for mother state…`
        );
      }
      try {
        await waitForMotherRegistration({
          cotiCtx: params.coti,
          mother: params.mother,
          sourceChainId: BigInt(params.source.chainId),
          pToken: params.pToken,
          timeoutMs: 15_000,
          pollMs: 2_000,
        });
        return "already";
      } catch {
        continue;
      }
    }

    console.log(
      `[privacyPortal] ${label}: retryFailedRequest ${requestId} (execution failed — likely FactoryNotAllowed before allowlist)…`
    );
    const hash = await cotiInbox.write.retryFailedRequest([requestId], {
      account: params.coti.walletClient.account,
      gas: 5_000_000n,
    });
    await waitMined(params.coti.publicClient, hash);
    console.log(`[privacyPortal] ${label}: retry tx ${hash}`);

    try {
      await waitForMotherRegistration({
        cotiCtx: params.coti,
        mother: params.mother,
        sourceChainId: BigInt(params.source.chainId),
        pToken: params.pToken,
        timeoutMs: 60_000,
        pollMs: 2_000,
      });
      return "retried";
    } catch {
      console.warn(`[privacyPortal] ${label}: still unregistered after retry ${requestId}`);
    }
  }

  throw new Error(
    `${label}: mother registration still pending. ` +
      `Tried requestIds=${requestIds.join(",") || "(none)"}. ` +
      `Ensure PpMotherAllow ran on COTI and the off-chain miner has ingested the outbound. ` +
      `Then re-run to call permissionless retryFailedRequest for ERROR_CODE_EXECUTION_FAILED.`
  );
};

export const logDeployment = async (ctx: ConnectedNetwork, contract: string, address: `0x${string}`) => {
  await appendDeploymentLog({
    contract,
    address,
    chainId: ctx.chainId,
    network: ctx.chainName,
  });
};
