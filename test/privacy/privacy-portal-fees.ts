import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { zeroAddress } from "viem";
import { oracleTokensForChain } from "../../scripts/oracle-tokens.js";
import {
  DEFAULT_POD_FEE,
  MAX_PACKED_FEE,
  burnAccumulatedPTokens,
  completePTokenTransferCallback,
  deployDirectPortalContext,
  deployPortalFactory,
  depositPublicToken,
  fundUserAndApprovePortal,
  requestWithdraw,
  seedPortalVault,
  type PortalTestContext,
} from "./privacy-portal-utils.js";

describe("PrivacyPortal fees", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;

  it("collects portal fee on deposit and allows owner sweep", async function () {
    const ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    const portalFee = 50n;
    await fundUserAndApprovePortal(ctx, 100n);
    await depositPublicToken(ctx, 100n, { portalFee });

    assert.equal(await ctx.portal.read.accumulatedPortalFees(), portalFee);
    await ctx.portal.write.withdrawPortalFees([portalFee], { account: owner });
    assert.equal(await ctx.portal.read.accumulatedPortalFees(), 0n);
  });

  it("rejects underpay portal fee on deposit", async function () {
    const ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    const fixedFee = 10n;
    const { factory } = await deployPortalFactory(ctx, {
      depositFixedFee: fixedFee,
      depositMaxFee: 1000n,
    });
    const underlying = await ctx.viem.deployContract("MockERC20", ["Min", "MIN", 18], {
      client: { public: ctx.publicClient, wallet: ctx.wallet },
    });
    await factory.write.createPortal(
      [underlying.address, "Private MIN", "pMIN", 18, false, owner],
      { account: owner, value: 2_500_000_000_000n }
    );
    const portalAddr = await factory.read.portalForUnderlying([underlying.address]);
    await underlying.write.mint([owner, 100n], { account: owner });
    await underlying.write.approve([portalAddr, 100n], { account: owner });

    await assert.rejects(
      ctx.viem.getContractAt("PrivacyPortal", portalAddr).then((portal: any) =>
        portal.write.deposit([owner, 100n, fixedFee - 1n, 77n], {
          account: owner,
          value: DEFAULT_POD_FEE + fixedFee - 1n,
        })
      ),
      /InsufficientPortalFee/
    );
  });

  it("factory with no oracle uses fixed fee floor only", async function () {
    const ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    const fixedFee = 25n;
    const { factory } = await deployPortalFactory(ctx, {
      depositFixedFee: fixedFee,
      depositMaxFee: 1000n,
      withdrawFixedFee: fixedFee,
      withdrawMaxFee: 1000n,
    });

    const underlying = await ctx.viem.deployContract("MockERC20", ["Fee", "FEE", 18], {
      client: { public: ctx.publicClient, wallet: ctx.wallet },
    });
    await factory.write.createPortal(
      [underlying.address, "Private FEE", "pFEE", 18, false, owner],
      { account: owner, value: 2_500_000_000_000n }
    );
    const portalAddr = await factory.read.portalForUnderlying([underlying.address]);
    const portal = await viem.getContractAt("PrivacyPortal", portalAddr, {
      client: { public: ctx.publicClient, wallet },
    });

    const [fee, usedDynamic] = await portal.read.estimateDepositFees([1000n]);
    assert.equal(fee, fixedFee);
    assert.equal(usedDynamic, false);

    const [factoryFee] = await factory.read.estimateDepositPortalFee([underlying.address, 1000n, 18]);
    assert.equal(factoryFee, fixedFee);
  });

  it("portal owner can override factory default fees", async function () {
    const ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    const factoryFixed = 10n;
    const overrideFixed = 40n;
    const { factory } = await deployPortalFactory(ctx, {
      depositFixedFee: factoryFixed,
      depositMaxFee: MAX_PACKED_FEE,
    });

    const underlying = await ctx.viem.deployContract("MockERC20", ["OVR", "OVR", 18], {
      client: { public: ctx.publicClient, wallet: ctx.wallet },
    });
    await factory.write.createPortal(
      [underlying.address, "Private OVR", "pOVR", 18, false, owner],
      { account: owner, value: 2_500_000_000_000n }
    );
    const portalAddr = await factory.read.portalForUnderlying([underlying.address]);
    const portal = await viem.getContractAt("PrivacyPortal", portalAddr, {
      client: { public: ctx.publicClient, wallet },
    });

    await portal.write.setDepositFee([overrideFixed, 0n, MAX_PACKED_FEE], { account: owner });
    const [fee] = await portal.read.estimateDepositFees([100n]);
    assert.equal(fee, overrideFixed);

    await portal.write.clearDepositFeeOverride({ account: owner });
    const [feeAfterClear] = await portal.read.estimateDepositFees([100n]);
    assert.equal(feeAfterClear, factoryFixed);
  });

  it("withdraw collects portal fee and batch burn uses separate pod fee", async function () {
    const ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    const portalFee = 30n;
    await seedPortalVault(ctx, 500n);
    await requestWithdraw(ctx, 200n, { portalFee });

    assert.equal(await ctx.portal.read.accumulatedPortalFees(), portalFee);
    await completePTokenTransferCallback(ctx);
    assert.equal(await ctx.portal.read.pendingBurnAmount(), 200n);
    assert.equal(await ctx.pToken.read.burnedAmount(), 0n);

    await burnAccumulatedPTokens(ctx, 200n);
    assert.equal(await ctx.portal.read.pendingBurnAmount(), 0n);
    assert.equal(await ctx.pToken.read.burnedAmount(), 200n);
  });

  it("dynamic pricing works after oracle sync", async function () {
    const ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    const oracle = await ctx.viem.deployContract("PortalFeeOracle", [owner], {
      client: { public: ctx.publicClient, wallet: ctx.wallet },
    });
    const { portalNative } = oracleTokensForChain(31337);
    await oracle.write.setTokenPriceUSD([portalNative, 2000n * 10n ** 18n], { account: owner });

    const underlying = await ctx.viem.deployContract("MockERC20", ["USD", "USD", 6], {
      client: { public: ctx.publicClient, wallet: ctx.wallet },
    });
    await oracle.write.setTokenPriceUSD([underlying.address, 1n * 10n ** 18n], { account: owner });

    const { factory } = await deployPortalFactory(ctx, {
      priceOracle: oracle.address,
      depositFixedFee: 1n,
      depositPercentageBps: 500n,
      depositMaxFee: 1_000_000n,
    });

    const [fee, usedDynamic] = await factory.read.estimateDepositPortalFee([underlying.address, 1_000_000n, 6]);
    assert.ok(fee >= 1n);
    assert.equal(usedDynamic, true);
  });

  it("packFeeConfig reverts invalid configuration via factory setter", async function () {
    const ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    const { factory } = await deployPortalFactory(ctx);

    await assert.rejects(
      factory.write.setDefaultDepositFee([100n, 0n, 50n], { account: owner }),
      /InvalidFeeConfiguration/
    );
  });

  it("getFeeConfig returns unpacked fields for factory and portal", async function () {
    const ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });
    const depositFixed = 25n;
    const depositBps = 500n;
    const depositMax = 1000n;
    const { factory } = await deployPortalFactory(ctx, {
      depositFixedFee: depositFixed,
      depositPercentageBps: depositBps,
      depositMaxFee: depositMax,
    });

    const factoryCfg = await factory.read.getFeeConfig([true]);
    assert.equal(factoryCfg.fixedFee, depositFixed);
    assert.equal(factoryCfg.percentageBps, depositBps);
    assert.equal(factoryCfg.maxFee, depositMax);

    const underlying = await ctx.viem.deployContract("MockERC20", ["Cfg", "CFG", 18], {
      client: { public: ctx.publicClient, wallet: ctx.wallet },
    });
    await factory.write.createPortal(
      [underlying.address, "Private CFG", "pCFG", 18, false, owner],
      { account: owner, value: 2_500_000_000_000n }
    );
    const portalAddr = await factory.read.portalForUnderlying([underlying.address]);
    const portal = await viem.getContractAt("PrivacyPortal", portalAddr, {
      client: { public: ctx.publicClient, wallet },
    });

    const portalCfg = await portal.read.getFeeConfig([true]);
    assert.equal(portalCfg.fixedFee, depositFixed);
    assert.equal(portalCfg.percentageBps, depositBps);
    assert.equal(portalCfg.maxFee, depositMax);

    const overrideFixed = 99n;
    await portal.write.setDepositFee([overrideFixed, 100n, 2000n], { account: owner });
    const [overrideCfg, isSet] = await portal.read.getFeeConfigOverride([true]);
    assert.equal(isSet, true);
    assert.equal(overrideCfg.fixedFee, overrideFixed);
    assert.equal(overrideCfg.percentageBps, 100n);
    assert.equal(overrideCfg.maxFee, 2000n);

    const effectiveCfg = await portal.read.getFeeConfig([true]);
    assert.equal(effectiveCfg.fixedFee, overrideFixed);
  });
});
