# Fee + Oracle Examples (viem)

Assumes ABIs exported from linked contracts. Replace addresses from your app's `deployConfig.json` loader.

## Load chain config

```ts
import deployConfig from "../deployConfig.json" assert { type: "json" };

type ChainConfig = {
  priceOracle: `0x${string}`;
  privacyPortalFactory: `0x${string}`;
  privacyPortalTokens: Record<string, { portal: `0x${string}`; underlying: `0x${string}` }>;
};

const sepolia = deployConfig.chains["11155111"] as ChainConfig;
const fuji = deployConfig.chains["43113"] as ChainConfig;
```

## Quote all fees (deposit)

```ts
type DepositQuote = {
  portalFee: bigint;
  usedDynamicPricing: boolean;
  mintTotalFee: bigint;
  mintCallbackFee: bigint;
  msgValue: bigint; // ERC20 deposit
};

async function quoteDepositFees(
  publicClient: any,
  portal: `0x${string}`,
  amount: bigint,
  privacyPortalAbi: any
): Promise<DepositQuote> {
  const [portalFee, usedDynamicPricing, mintTotalFee, mintCallbackFee] =
    await publicClient.readContract({
      address: portal,
      abi: privacyPortalAbi,
      functionName: "estimateDepositFees",
      args: [amount],
    });

  return {
    portalFee,
    usedDynamicPricing,
    mintTotalFee,
    mintCallbackFee,
    msgValue: portalFee + mintTotalFee,
  };
}
```

## Quote all fees (withdraw)

```ts
type WithdrawQuote = {
  portalFee: bigint;
  usedDynamicPricing: boolean;
  transferTotalFee: bigint;
  transferCallbackFee: bigint;
  msgValue: bigint;
};

async function quoteWithdrawFees(
  publicClient: any,
  portal: `0x${string}`,
  amount: bigint,
  privacyPortalAbi: any
): Promise<WithdrawQuote> {
  const [portalFee, usedDynamicPricing, transferTotalFee, transferCallbackFee] =
    await publicClient.readContract({
      address: portal,
      abi: privacyPortalAbi,
      functionName: "estimateWithdrawFees",
      args: [amount],
    });

  return {
    portalFee,
    usedDynamicPricing,
    transferTotalFee,
    transferCallbackFee,
    msgValue: portalFee + transferTotalFee,
  };
}
```

## UI fee breakdown display

```ts
function formatFeeBreakdown(q: DepositQuote | WithdrawQuote, nativeSymbol: string) {
  const podFee = "mintTotalFee" in q ? q.mintTotalFee : q.transferTotalFee;
  return {
    lines: [
      { label: "Portal fee", wei: q.portalFee, dynamic: q.usedDynamicPricing },
      { label: "PoD network fee", wei: podFee },
      { label: "Total (msg.value)", wei: q.msgValue },
    ],
    nativeSymbol,
  };
}
```

## Deposit (ERC20) — upgraded write

```ts
async function depositUpgraded({
  publicClient,
  walletClient,
  portal,
  underlying,
  user,
  recipient,
  amount,
  erc20Abi,
  privacyPortalAbi,
}: any) {
  const fees = await quoteDepositFees(publicClient, portal, amount, privacyPortalAbi);

  const allowance = await publicClient.readContract({
    address: underlying,
    abi: erc20Abi,
    functionName: "allowance",
    args: [user, portal],
  });
  if (allowance < amount) {
    const approveHash = await walletClient.writeContract({
      address: underlying,
      abi: erc20Abi,
      functionName: "approve",
      args: [portal, amount],
      account: user,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  const hash = await walletClient.writeContract({
    address: portal,
    abi: privacyPortalAbi,
    functionName: "deposit",
    args: [recipient, amount, fees.portalFee, fees.mintCallbackFee],
    value: fees.msgValue,
    account: user,
  });

  return { hash, fees };
}
```

## Deposit (native WETH/WAVAX)

```ts
async function depositNativeUpgraded({
  walletClient,
  portal,
  user,
  recipient,
  amount,
  privacyPortalAbi,
  publicClient,
}: any) {
  const fees = await quoteDepositFees(publicClient, portal, amount, privacyPortalAbi);

  const hash = await walletClient.writeContract({
    address: portal,
    abi: privacyPortalAbi,
    functionName: "depositNative",
    args: [recipient, amount, fees.portalFee, fees.mintCallbackFee],
    value: amount + fees.msgValue, // amount + portalFee + mintTotalFee
    account: user,
  });

  return { hash, fees };
}
```

## Withdraw — upgraded write (no burn fees)

```ts
import { hexToSignature } from "viem";

async function withdrawUpgraded({
  publicClient,
  walletClient,
  portal,
  user,
  recipient,
  amount,
  deadline,
  sourceChainId,
  privacyPortalAbi,
  podPTokenAbi,
}: any) {
  const pToken = await publicClient.readContract({
    address: portal,
    abi: privacyPortalAbi,
    functionName: "pToken",
  });

  const fees = await quoteWithdrawFees(publicClient, portal, amount, privacyPortalAbi);

  const [name, nonce] = await Promise.all([
    publicClient.readContract({ address: pToken, abi: podPTokenAbi, functionName: "name" }),
    publicClient.readContract({ address: pToken, abi: podPTokenAbi, functionName: "nonces", args: [user] }),
  ]);

  const signature = await walletClient.signTypedData({
    account: user,
    domain: { name, version: "1", chainId: sourceChainId, verifyingContract: pToken },
    types: {
      TransferPermit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "TransferPermit",
    message: { owner: user, spender: portal, to: portal, value: amount, nonce, deadline },
  });

  const { v, r, s } = hexToSignature(signature);

  const hash = await walletClient.writeContract({
    address: portal,
    abi: privacyPortalAbi,
    functionName: "requestWithdrawWithPermit",
    args: [
      recipient,
      amount,
      fees.portalFee,
      fees.transferTotalFee,
      fees.transferCallbackFee,
      deadline,
      v,
      r,
      s,
    ],
    value: fees.msgValue,
    account: user,
  });

  return { hash, fees, pToken };
}
```

## Live oracle prices (Sepolia ETH + collateral)

```ts
const PRICE_SCALE = 10n ** 18n;

function usdFromPrice18(price: bigint): number {
  return Number(price) / Number(PRICE_SCALE);
}

async function readLivePrices({
  publicClient,
  factory,
  portal,
  factoryAbi,
  portalAbi,
  podPriceOracleAbi,
}: {
  publicClient: any;
  factory: `0x${string}`;
  portal: `0x${string}`;
  factoryAbi: any;
  portalAbi: any;
  podPriceOracleAbi: any;
}) {
  const [oracle, nativeToken, underlying] = await Promise.all([
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "priceOracle" }),
    publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "nativeToken" }),
    publicClient.readContract({ address: portal, abi: portalAbi, functionName: "underlying" }),
  ]);

  const [nativeUsd, collateralUsd] = await publicClient.readContract({
    address: oracle,
    abi: podPriceOracleAbi,
    functionName: "getLivePrices",
    args: [nativeToken, underlying],
  });

  return {
    oracle,
    nativeToken,
    underlying,
    nativeUsd,
    collateralUsd,
    nativeUsdDisplay: usdFromPrice18(nativeUsd),
    collateralUsdDisplay: usdFromPrice18(collateralUsd),
    oracleHealthy: nativeUsd > 0n && collateralUsd > 0n,
  };
}

// Sepolia WETH portal example
await readLivePrices({
  publicClient,
  factory: sepolia.privacyPortalFactory,
  portal: sepolia.privacyPortalTokens.pWETH.portal,
  factoryAbi,
  portalAbi,
  podPriceOracleAbi,
});
// nativeUsdDisplay ≈ ETH/USD; collateralUsdDisplay ≈ ETH/USD for pWETH

// Fuji WAVAX portal example
await readLivePrices({
  publicClient,
  factory: fuji.privacyPortalFactory,
  portal: fuji.privacyPortalTokens.pWAVAX.portal,
  factoryAbi,
  portalAbi,
  podPriceOracleAbi,
});
// nativeUsdDisplay ≈ AVAX/USD
```

## Single-token price (e.g. show AVAX spot in header)

```ts
async function readNativeSpot(
  publicClient: any,
  priceOracle: `0x${string}`,
  nativeToken: `0x${string}`,
  podPriceOracleAbi: any
) {
  const price = await publicClient.readContract({
    address: priceOracle,
    abi: podPriceOracleAbi,
    functionName: "getLivePrice",
    args: [nativeToken],
  });
  return { wei: price, usd: usdFromPrice18(price) };
}

// Sepolia: nativeToken = WETH
await readNativeSpot(publicClient, sepolia.priceOracle, "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", podPriceOracleAbi);

// Fuji: nativeToken = WAVAX
await readNativeSpot(publicClient, fuji.priceOracle, "0xd00ae08403B9bbb9124bB305C09058E32C39A48c", podPriceOracleAbi);
```

## Re-quote before submit

Oracle-backed portal fees move with spot prices. Re-fetch estimates immediately before `writeContract` (after user confirms amount). If `usedDynamicPricing` is true, show "feeds live" and refresh on interval or when amount changes.
