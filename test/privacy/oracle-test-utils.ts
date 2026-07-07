import assert from "node:assert/strict";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { CHAINLINK_FEEDS, BAND_STD_REF_BY_CHAIN } from "../../scripts/deploy-utils.js";
import { canonicalUnderlying } from "../../scripts/privacyPortal/canonical-collateral.js";
import { oracleTokensForChain } from "../../scripts/oracle-tokens.js";

export const FEE_DIVISOR = 1_000_000n;
export const PRICE_SCALE = 10n ** 18n;
export const SEPOLIA_CHAIN_ID = 11155111;

const sepoliaRpc = () =>
  process.env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia.publicnode.com";

export const sepoliaPublicClient = () =>
  createPublicClient({ chain: sepolia, transport: http(sepoliaRpc()) });

const chainlinkAggAbi = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
]);

const bandRefAbi = [
  {
    name: "getReferenceData",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "string" }, { type: "string" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { type: "uint256", name: "rate" },
          { type: "uint256", name: "lastUpdatedBase" },
          { type: "uint256", name: "lastUpdatedQuote" },
        ],
      },
    ],
  },
] as const;

/** Format 18-decimal USD fixed-point as a dollar string. */
export const formatUsd18 = (price: bigint, digits = 2): string =>
  (Number(price) / 1e18).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** Normalize a Chainlink aggregator answer to 18-decimal USD, with feed metadata. */
export const readChainlinkUsd18WithMeta = async (
  aggregator: `0x${string}`
): Promise<{ price: bigint; updatedAt: bigint }> => {
  const client = sepoliaPublicClient();
  const feed = getAddress(aggregator);
  const decimals = await client.readContract({
    address: feed,
    abi: chainlinkAggAbi,
    functionName: "decimals",
  });
  const [, answer, , updatedAt] = await client.readContract({
    address: feed,
    abi: chainlinkAggAbi,
    functionName: "latestRoundData",
  });
  assert.ok(answer > 0n, `${feed}: non-positive Chainlink answer`);
  let price: bigint;
  if (decimals === 18) {
    price = answer;
  } else if (decimals < 18) {
    price = answer * 10n ** BigInt(18 - decimals);
  } else {
    price = (answer * PRICE_SCALE) / 10n ** BigInt(decimals);
  }
  return { price, updatedAt };
};

/** Normalize a Chainlink aggregator answer to 18-decimal USD (matches {ChainlinkFeedLib}). */
export const readChainlinkUsd18 = async (aggregator: `0x${string}`): Promise<bigint> =>
  (await readChainlinkUsd18WithMeta(aggregator)).price;

/** Read Band base/USDC rate (18 decimals) with feed timestamp. */
export const readBandUsd18WithMeta = async (
  base: string
): Promise<{ price: bigint; updatedAt: bigint }> => {
  const client = sepoliaPublicClient();
  const ref = getAddress(SEPOLIA_ORACLE.bandStdRef);
  const data = await client.readContract({
    address: ref,
    abi: bandRefAbi,
    functionName: "getReferenceData",
    args: [base, "USDC"],
  });
  const updatedAt =
    data.lastUpdatedBase < data.lastUpdatedQuote ? data.lastUpdatedBase : data.lastUpdatedQuote;
  return { price: data.rate, updatedAt };
};

/** Read Band base/USDC rate (18 decimals). */
export const readBandUsd18 = async (base: string): Promise<bigint> =>
  (await readBandUsd18WithMeta(base)).price;

export type SepoliaLiveToken = {
  /** Display name (e.g. WBTC uses BTC feeds). */
  name: string;
  /** ERC-20 used as oracle key in production adapters. */
  token: `0x${string}`;
  chainlinkFeed: `0x${string}`;
  minUsd: number;
  maxUsd: number;
  /** Band StdReference base symbol; omitted when unavailable on Sepolia. */
  bandBase?: string;
  /** Optional looser Band range (Sepolia Band feeds can be stale vs Chainlink). */
  bandMinUsd?: number;
  bandMaxUsd?: number;
};

/** Sepolia tokens for live oracle smoke tests (ETH, WBTC≈BTC, USDC). */
export const SEPOLIA_LIVE_TOKENS: readonly SepoliaLiveToken[] = [
  {
    name: "ETH",
    token: oracleTokensForChain(SEPOLIA_CHAIN_ID).localToken,
    chainlinkFeed: CHAINLINK_FEEDS.sepoliaEthUsd,
    bandBase: "ETH",
    minUsd: 500,
    maxUsd: 50_000,
    bandMinUsd: 500,
    bandMaxUsd: 50_000,
  },
  {
    name: "WBTC",
    /** Sepolia has no canonical WBTC; BTC/USD Chainlink feed proxies WBTC spot. */
    token: "0x0000000000000000000000000000000000000B1C" as `0x${string}`,
    chainlinkFeed: CHAINLINK_FEEDS.sepoliaBtcUsd,
    minUsd: 10_000,
    maxUsd: 500_000,
  },
  {
    name: "USDC",
    token: canonicalUnderlying(SEPOLIA_CHAIN_ID, "USDC")!,
    chainlinkFeed: CHAINLINK_FEEDS.sepoliaUsdcUsd,
    bandBase: "USDC",
    minUsd: 0.95,
    maxUsd: 1.05,
    bandMinUsd: 0.95,
    bandMaxUsd: 1.05,
  },
];

export const SEPOLIA_ORACLE = {
  ...oracleTokensForChain(SEPOLIA_CHAIN_ID),
  usdc: canonicalUnderlying(SEPOLIA_CHAIN_ID, "USDC")!,
  chainlink: {
    ethUsd: CHAINLINK_FEEDS.sepoliaEthUsd,
    btcUsd: CHAINLINK_FEEDS.sepoliaBtcUsd,
    usdcUsd: CHAINLINK_FEEDS.sepoliaUsdcUsd,
  },
  bandStdRef: BAND_STD_REF_BY_CHAIN[SEPOLIA_CHAIN_ID]!,
} as const;

const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;

/** Mirror {PrivacyPortalFeeLib.resolvePortalFee}. */
export const expectedDynamicPortalFee = (params: {
  amount: bigint;
  decimals: number;
  collateralUsd: bigint;
  nativeUsd: bigint;
  fixedFee: bigint;
  bps: bigint;
  maxFee: bigint;
}): bigint => {
  if (params.bps === 0n || params.collateralUsd === 0n || params.nativeUsd === 0n) {
    return params.fixedFee;
  }
  const txValueUsd = mulDiv(params.amount, params.collateralUsd, 10n ** BigInt(params.decimals));
  const percentageFeeUsd = mulDiv(txValueUsd, params.bps, FEE_DIVISOR);
  const percentageFeeNative = mulDiv(percentageFeeUsd, PRICE_SCALE, params.nativeUsd);
  const fee = percentageFeeNative > params.fixedFee ? percentageFeeNative : params.fixedFee;
  return fee > params.maxFee ? params.maxFee : fee;
};

export const assertUsdPrice18 = (label: string, price: bigint, minUsd: number, maxUsd: number) => {
  assert.ok(price > 0n, `${label}: oracle returned zero`);
  const usd = Number(price) / 1e18;
  assert.ok(
    usd >= minUsd && usd <= maxUsd,
    `${label}: $${usd.toFixed(4)} outside [$${minUsd}, $${maxUsd}]`
  );
};
