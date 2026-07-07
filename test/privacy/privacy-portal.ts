import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { zeroHash } from "viem";
import {
  burnAccumulatedPTokens,
  completePTokenTransferCallback,
  deployPortalFactory,
  deployDirectPortalContext,
  deployFactoryPortalPair,
  depositPublicToken,
  depositNativeToken,
  deployNativePortalContext,
  DEFAULT_POD_FEE,
  expectDepositMintSubmitted,
  expectWithdrawTransferSubmitted,
  fundUserAndApprovePortal,
  markPTokenTransferSuccessful,
  requestWithdraw,
  seedNativePortalVault,
  seedPortalVault,
  triggerWithdrawalRelease,
  zeroAddress,
  type PortalTestContext,
} from "./privacy-portal-utils.js";

describe("PrivacyPortal", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;

  const freshPortal = () => deployDirectPortalContext({ viem, publicClient, wallet, owner });

  let ctx: PortalTestContext;

  before(async function () {
    ctx = await freshPortal();
  });

  it("deposit locks underlying and submits a public pToken mint", async function () {
    ctx = await freshPortal();

    await fundUserAndApprovePortal(ctx, 250n);
    await depositPublicToken(ctx, 250n);

    await expectDepositMintSubmitted(ctx, { amount: 250n });
  });

  it("withdraw submits a pToken transfer request without reading private balances", async function () {
    ctx = await freshPortal();
    await seedPortalVault(ctx, 500n);

    await requestWithdraw(ctx, 300n);

    await expectWithdrawTransferSubmitted(ctx, 300n);
  });

  it("withdraw callback releases underlying and queues pTokens for batch burn", async function () {
    ctx = await freshPortal();
    await seedPortalVault(ctx, 500n);
    await requestWithdraw(ctx, 300n);

    const beforeRecipient = await ctx.underlying.read.balanceOf([ctx.recipient]);
    await completePTokenTransferCallback(ctx);

    assert.equal(await ctx.underlying.read.balanceOf([ctx.recipient]), beforeRecipient + 300n);
    assert.equal(await ctx.pToken.read.burnedAmount(), 0n);
    assert.equal(await ctx.portal.read.pendingBurnAmount(), 300n);
  });

  it("manual withdrawal trigger releases after pToken transfer succeeds", async function () {
    ctx = await freshPortal();
    await seedPortalVault(ctx, 500n);
    const { withdrawalId } = await requestWithdraw(ctx, 300n);

    const beforeRecipient = await ctx.underlying.read.balanceOf([ctx.recipient]);
    await markPTokenTransferSuccessful(ctx);
    await triggerWithdrawalRelease(ctx, withdrawalId);

    assert.equal(await ctx.underlying.read.balanceOf([ctx.recipient]), beforeRecipient + 300n);
    assert.equal(await ctx.portal.read.pendingBurnAmount(), 300n);
  });

  it("owner batch burn clears pendingBurnAmount", async function () {
    ctx = await freshPortal();
    await seedPortalVault(ctx, 500n);
    await requestWithdraw(ctx, 125n);
    await completePTokenTransferCallback(ctx);

    assert.equal(await ctx.portal.read.pendingBurnAmount(), 125n);
    await burnAccumulatedPTokens(ctx, 125n);
    assert.equal(await ctx.portal.read.pendingBurnAmount(), 0n);
    assert.equal(await ctx.pToken.read.burnedAmount(), 125n);
  });

  it("manual withdrawal trigger rejects before pToken transfer succeeds", async function () {
    ctx = await freshPortal();
    await seedPortalVault(ctx, 500n);
    const { withdrawalId } = await requestWithdraw(ctx, 300n);

    await assert.rejects(
      triggerWithdrawalRelease(ctx, withdrawalId),
      /PTokenTransferNotSuccessful/
    );
  });

  it("callback retry does not release twice", async function () {
    ctx = await freshPortal();
    await seedPortalVault(ctx, 500n);
    await requestWithdraw(ctx, 125n);

    const beforeRecipient = await ctx.underlying.read.balanceOf([ctx.recipient]);
    await completePTokenTransferCallback(ctx);
    await assert.rejects(completePTokenTransferCallback(ctx));

    assert.equal(await ctx.underlying.read.balanceOf([ctx.recipient]), beforeRecipient + 125n);
    assert.equal(await ctx.portal.read.pendingBurnAmount(), 125n);
  });

  it("rejects portal callbacks that do not come from the configured pToken", async function () {
    ctx = await freshPortal();

    await assert.rejects(
      ctx.portal.write.onPTokenTransferred([zeroHash], { account: owner }),
      /OnlyPToken/
    );
  });

  it("factory deploys one portal and pToken clone per underlying token", async function () {
    ctx = await freshPortal();

    const { factory, underlying, portal, pToken } = await deployFactoryPortalPair(ctx);

    assert.notEqual(portal, zeroAddress);
    assert.notEqual(pToken, zeroAddress);
    assert.equal(await factory.read.portalForUnderlying([underlying.address]), portal);
    assert.equal(await factory.read.pTokenForUnderlying([underlying.address]), pToken);
    assert.equal(await factory.read.portalForPToken([pToken]), portal);

    const factoryPortal = await viem.getContractAt("PrivacyPortal", portal, {
      client: { public: publicClient, wallet },
    });
    const factoryPToken = await viem.getContractAt("PodErc20MintableInitializable", pToken, {
      client: { public: publicClient, wallet },
    });
    assert.equal(await factoryPortal.read.decimals(), 6);
    assert.equal(await factoryPToken.read.decimals(), 6);
  });

  it("factory pause disables withdrawals across factory-created portals", async function () {
    ctx = await freshPortal();
    const { factory, portal } = await deployFactoryPortalPair(ctx);
    const factoryPortal = await viem.getContractAt("PrivacyPortal", portal, {
      client: { public: publicClient, wallet },
    });

    await factory.write.setWithdrawalsPaused([true], { account: owner });

    await assert.rejects(
      factoryPortal.write.requestWithdrawWithPermit(
        [ctx.recipient, 1n, 0n, DEFAULT_POD_FEE, 100n, 999_999_999n, 27, zeroHash, zeroHash],
        { account: owner, value: DEFAULT_POD_FEE }
      ),
      /WithdrawalsPaused/
    );
  });

  it("factory deposit pause disables deposits across factory-created portals", async function () {
    ctx = await freshPortal();
    const { factory, portal, underlying } = await deployFactoryPortalPair(ctx);
    const factoryPortal = await viem.getContractAt("PrivacyPortal", portal, {
      client: { public: publicClient, wallet },
    });

    await underlying.write.mint([owner, 100n], { account: owner });
    await underlying.write.approve([portal, 100n], { account: owner });
    await factory.write.setDepositsPaused([true], { account: owner });

    await assert.rejects(
      factoryPortal.write.deposit([owner, 50n, 0n, 77n], { account: owner, value: DEFAULT_POD_FEE }),
      /DepositsPaused/
    );
  });

  it("COTI mother contract deploys and allowlists source factories", async function () {
    ctx = await freshPortal();
    const { mother, factory, inbox } = await deployPortalFactory(ctx);

    assert.notEqual(mother.address, zeroAddress);
    assert.equal((await factory.read.cotiMotherContract()).toLowerCase(), mother.address.toLowerCase());

    await mother.write.setAllowedFactory([31337n, factory.address, true], { account: owner });
    assert.equal(await mother.read.allowedFactories([31337n, factory.address]), true);
    assert.equal((await mother.read.inbox()).toLowerCase(), inbox.address.toLowerCase());
  });

  it("depositNative wraps native coin and submits a public pToken mint", async function () {
    const nativeCtx = await deployNativePortalContext({ viem, publicClient, wallet, owner });
    const mintFee = DEFAULT_POD_FEE;

    await depositNativeToken(nativeCtx, 250n, { mintFee });

    assert.equal(await nativeCtx.underlying.read.balanceOf([nativeCtx.portal.address]), 250n);
    await expectDepositMintSubmitted(nativeCtx, { amount: 250n, mintFee });
  });

  it("native portal releases wrapped underlying on withdraw release", async function () {
    const nativeCtx = await deployNativePortalContext({ viem, publicClient, wallet, owner });
    await seedNativePortalVault(nativeCtx, 500n);
    await requestWithdraw(nativeCtx, 300n);

    const recipientEthBefore = await publicClient.getBalance({ address: nativeCtx.recipient });
    await completePTokenTransferCallback(nativeCtx);

    assert.equal(await nativeCtx.underlying.read.balanceOf([nativeCtx.recipient]), 300n);
    assert.equal(await publicClient.getBalance({ address: nativeCtx.recipient }), recipientEthBefore);
  });
});
