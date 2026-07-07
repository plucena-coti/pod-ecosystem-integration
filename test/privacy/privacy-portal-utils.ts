import assert from "node:assert/strict";
import { encodePacked, getAddress, keccak256, zeroAddress, zeroHash, type PublicClient, type WalletClient } from "viem";
import { oracleTokensForChain } from "../../scripts/oracle-tokens.js";

export const RECIPIENT = "0x00000000000000000000000000000000000000b0" as `0x${string}`;

/** Mock pToken {estimateFee} total leg fee. */
export const DEFAULT_POD_FEE = 1000n;
/** Zero portal fee when using {MockPrivacyPortalFactory}. */
export const DEFAULT_PORTAL_FEE = 0n;

export const DEFAULT_WITHDRAW = {
  portalFee: DEFAULT_PORTAL_FEE,
  transferFee: DEFAULT_POD_FEE,
  transferCallbackFee: 100n,
  permitDeadline: 999_999_999n,
  v: 27,
  r: zeroHash,
  s: zeroHash,
} as const;

export const MAX_PACKED_FEE = (1n << 128n) - 1n;

export type PortalTestContext = {
  viem: any;
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: `0x${string}`;
  recipient: `0x${string}`;
  underlying: any;
  pToken: any;
  portal: any;
  mockFactory?: any;
};

const writeOpts = (ctx: PortalTestContext) => ({ account: ctx.owner });

export async function deployMockPortalFactory(params: {
  viem: any;
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: `0x${string}`;
}) {
  const { portalNative } = oracleTokensForChain(31337);
  return params.viem.deployContract("MockPrivacyPortalFactory", [params.owner, portalNative], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
}

export async function deployDirectPortalContext(params: {
  viem: any;
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: `0x${string}`;
}): Promise<PortalTestContext> {
  const mockFactory = await deployMockPortalFactory(params);
  const cloneHelper = await params.viem.deployContract("CloneHelper", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const underlying = await params.viem.deployContract("MockERC20", ["USD Coin", "USDC", 18], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const pToken = await params.viem.deployContract("MockPodERC20ForPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const portalImpl = await params.viem.deployContract("PrivacyPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  await cloneHelper.write.clone([portalImpl.address], { account: params.owner });
  const portalAddress = (await cloneHelper.read.lastClone()) as `0x${string}`;
  const portal = await params.viem.getContractAt("PrivacyPortal", portalAddress, {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  await portal.write.initialize([params.owner, underlying.address, pToken.address, 18, false], {
    account: params.owner,
  });
  await portal.write.setPauseController([mockFactory.address], { account: params.owner });

  return {
    viem: params.viem,
    publicClient: params.publicClient,
    wallet: params.wallet,
    owner: params.owner,
    recipient: RECIPIENT,
    underlying,
    pToken,
    portal,
    mockFactory,
  };
}

export async function fundUserAndApprovePortal(ctx: PortalTestContext, amount: bigint) {
  await ctx.underlying.write.mint([ctx.owner, amount], writeOpts(ctx));
  await ctx.underlying.write.approve([ctx.portal.address, amount], writeOpts(ctx));
}

export async function depositPublicToken(
  ctx: PortalTestContext,
  amount: bigint,
  params: {
    recipient?: `0x${string}`;
    portalFee?: bigint;
    mintFee?: bigint;
    callbackFee?: bigint;
  } = {}
) {
  const portalFee = params.portalFee ?? DEFAULT_PORTAL_FEE;
  const mintFee = params.mintFee ?? DEFAULT_POD_FEE;
  await ctx.portal.write.deposit(
    [params.recipient ?? ctx.recipient, amount, portalFee, params.callbackFee ?? 77n],
    { ...writeOpts(ctx), value: mintFee + portalFee }
  );
}

export async function deployNativePortalContext(params: {
  viem: any;
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: `0x${string}`;
}): Promise<PortalTestContext> {
  const mockFactory = await deployMockPortalFactory(params);
  const cloneHelper = await params.viem.deployContract("CloneHelper", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const underlying = await params.viem.deployContract("MockWrappedNative", ["Wrapped Ether", "WETH"], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const pToken = await params.viem.deployContract("MockPodERC20ForPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const portalImpl = await params.viem.deployContract("PrivacyPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  await cloneHelper.write.clone([portalImpl.address], { account: params.owner });
  const portalAddress = (await cloneHelper.read.lastClone()) as `0x${string}`;
  const portal = await params.viem.getContractAt("PrivacyPortal", portalAddress, {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  await portal.write.initialize([params.owner, underlying.address, pToken.address, 18, true], {
    account: params.owner,
  });
  await portal.write.setPauseController([mockFactory.address], { account: params.owner });

  return {
    viem: params.viem,
    publicClient: params.publicClient,
    wallet: params.wallet,
    owner: params.owner,
    recipient: RECIPIENT,
    underlying,
    pToken,
    portal,
    mockFactory,
  };
}

export async function depositNativeToken(
  ctx: PortalTestContext,
  amount: bigint,
  params: { recipient?: `0x${string}`; portalFee?: bigint; mintFee?: bigint; callbackFee?: bigint } = {}
) {
  const portalFee = params.portalFee ?? DEFAULT_PORTAL_FEE;
  const mintFee = params.mintFee ?? DEFAULT_POD_FEE;
  await ctx.portal.write.depositNative(
    [params.recipient ?? ctx.recipient, amount, portalFee, params.callbackFee ?? 77n],
    { ...writeOpts(ctx), value: amount + mintFee + portalFee }
  );
}

export async function seedPortalVault(ctx: PortalTestContext, amount: bigint) {
  await ctx.underlying.write.mint([ctx.portal.address, amount], writeOpts(ctx));
}

/** Seed a native-wrapped portal vault with ETH-backed WETH (not bare mint). */
export async function seedNativePortalVault(ctx: PortalTestContext, amount: bigint) {
  await ctx.underlying.write.deposit({ account: ctx.owner, value: amount });
  await ctx.underlying.write.transfer([ctx.portal.address, amount], writeOpts(ctx));
}

export async function requestWithdraw(
  ctx: PortalTestContext,
  amount: bigint,
  params: { recipient?: `0x${string}`; portalFee?: bigint; transferFee?: bigint } = {}
) {
  const portalFee = params.portalFee ?? DEFAULT_WITHDRAW.portalFee;
  const transferFee = params.transferFee ?? DEFAULT_WITHDRAW.transferFee;
  const recipient = params.recipient ?? ctx.recipient;
  const nonce = await ctx.portal.read.withdrawalNonce();
  const withdrawalId = keccak256(
    encodePacked(
      ["address", "address", "address", "uint256", "uint256"],
      [ctx.portal.address, ctx.owner, recipient, amount, nonce]
    )
  );
  await ctx.portal.write.requestWithdrawWithPermit(
    [
      recipient,
      amount,
      portalFee,
      transferFee,
      DEFAULT_WITHDRAW.transferCallbackFee,
      DEFAULT_WITHDRAW.permitDeadline,
      DEFAULT_WITHDRAW.v,
      DEFAULT_WITHDRAW.r,
      DEFAULT_WITHDRAW.s,
    ],
    { ...writeOpts(ctx), value: transferFee + portalFee }
  );
  const transferRequestId = await ctx.pToken.read.lastTransferRequestId();
  return { withdrawalId, transferRequestId };
}

export async function completePTokenTransferCallback(ctx: PortalTestContext) {
  await ctx.pToken.write.markLastTransferSuccessful([], writeOpts(ctx));
  await ctx.pToken.write.triggerLastTransferCallback([], writeOpts(ctx));
}

export async function markPTokenTransferSuccessful(ctx: PortalTestContext) {
  await ctx.pToken.write.markLastTransferSuccessful([], writeOpts(ctx));
}

export async function triggerWithdrawalRelease(ctx: PortalTestContext, withdrawalId: `0x${string}`) {
  await ctx.portal.write.triggerWithdrawalRelease([withdrawalId], writeOpts(ctx));
}

export async function burnAccumulatedPTokens(ctx: PortalTestContext, amount: bigint, burnFee = DEFAULT_POD_FEE) {
  await ctx.portal.write.burnAccumulatedPTokens([amount, DEFAULT_WITHDRAW.transferCallbackFee], {
    ...writeOpts(ctx),
    value: burnFee,
  });
}

export async function expectDepositMintSubmitted(
  ctx: PortalTestContext,
  params: {
    amount: bigint;
    recipient?: `0x${string}`;
    mintFee?: bigint;
    portalFee?: bigint;
    callbackFee?: bigint;
  }
) {
  const portalFee = params.portalFee ?? DEFAULT_PORTAL_FEE;
  const mintFee = params.mintFee ?? DEFAULT_POD_FEE;
  assert.equal(await ctx.underlying.read.balanceOf([ctx.portal.address]), params.amount);
  assert.equal(await ctx.pToken.read.lastMintRecipient(), getAddress(params.recipient ?? ctx.recipient));
  assert.equal(await ctx.pToken.read.lastMintAmount(), params.amount);
  assert.equal(await ctx.pToken.read.lastMintValue(), mintFee);
  assert.equal(await ctx.pToken.read.lastMintCallbackFee(), params.callbackFee ?? 77n);
  assert.equal(await ctx.portal.read.accumulatedPortalFees(), portalFee);
}

export async function expectWithdrawTransferSubmitted(ctx: PortalTestContext, amount: bigint, portalFee = DEFAULT_PORTAL_FEE) {
  assert.equal(await ctx.pToken.read.lastTransferFrom(), getAddress(ctx.owner));
  assert.equal(await ctx.pToken.read.lastTransferTo(), getAddress(ctx.portal.address));
  assert.equal(await ctx.pToken.read.lastTransferAmount(), amount);
  assert.equal(await ctx.pToken.read.lastTransferValue(), DEFAULT_WITHDRAW.transferFee);
  assert.equal(await ctx.pToken.read.lastTransferCallbackFee(), DEFAULT_WITHDRAW.transferCallbackFee);
  assert.equal(await ctx.portal.read.withdrawalNonce(), 1n);
  assert.equal(await ctx.portal.read.accumulatedPortalFees(), portalFee);
}

export async function deployCotiMother(ctx: PortalTestContext, inboxAddress: `0x${string}`) {
  return ctx.viem.deployContract("PodErc20CotiMother", [inboxAddress, ctx.owner], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
}

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

const deployInboxWithFees = async (viem: any, chainId: bigint, client: { public: PublicClient; wallet: WalletClient }) => {
  const inbox = await deployInboxWithInit(viem, chainId, { client });
  const oracle = await viem.deployContract("PriceOracle", [client.wallet.account.address], { client });
  const { localToken, remoteToken } = oracleTokensForChain(Number(chainId));
  await oracle.write.setInboxTokens([localToken, remoteToken], { account: client.wallet.account.address });
  await oracle.write.setLocalTokenPriceUSD([10n ** 18n], { account: client.wallet.account.address });
  await oracle.write.setRemoteTokenPriceUSD([10n ** 18n], { account: client.wallet.account.address });
  await inbox.write.setPriceOracle([oracle.address], { account: client.wallet.account.address });
  await inbox.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], {
    account: client.wallet.account.address,
  });
  return inbox;
};

export async function deployPortalFactory(
  ctx: PortalTestContext,
  params: {
    priceOracle?: `0x${string}`;
    depositFixedFee?: bigint;
    depositPercentageBps?: bigint;
    depositMaxFee?: bigint;
    withdrawFixedFee?: bigint;
    withdrawPercentageBps?: bigint;
    withdrawMaxFee?: bigint;
  } = {}
) {
  const client = { public: ctx.publicClient, wallet: ctx.wallet };
  const inbox = await deployInboxWithFees(ctx.viem, 31337n, client);
  const mother = await deployCotiMother(ctx, inbox.address);
  const portalImplementation = await ctx.viem.deployContract("PrivacyPortal", [], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
  const tokenImplementation = await ctx.viem.deployContract("PodErc20MintableInitializable", [], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
  const { portalNative } = oracleTokensForChain(31337);
  const factory = await ctx.viem.deployContract(
    "PrivacyPortalFactory",
    [
      ctx.owner,
      inbox.address,
      7082400n,
      mother.address,
      tokenImplementation.address,
      portalImplementation.address,
      ctx.owner,
      portalNative,
      params.priceOracle ?? zeroAddress,
      params.depositFixedFee ?? 0n,
      params.depositPercentageBps ?? 0n,
      params.depositMaxFee ?? MAX_PACKED_FEE,
      params.withdrawFixedFee ?? 0n,
      params.withdrawPercentageBps ?? 0n,
      params.withdrawMaxFee ?? MAX_PACKED_FEE,
    ],
    { client: { public: ctx.publicClient, wallet: ctx.wallet } }
  );
  return { factory, mother, inbox };
}

export async function deployFactoryPortalPair(ctx: PortalTestContext) {
  const { factory } = await deployPortalFactory(ctx);
  const underlying = await ctx.viem.deployContract("MockERC20", ["Second", "SEC", 6], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });

  await factory.write.createPortal(
    [underlying.address, "Private SEC", "pSEC", 6, false, ctx.owner],
    { ...writeOpts(ctx), value: 2_500_000_000_000n }
  );

  const portal = await factory.read.portalForUnderlying([underlying.address]);
  const pToken = await factory.read.pTokenForUnderlying([underlying.address]);
  return { factory, underlying, portal, pToken };
}

export { zeroAddress };
