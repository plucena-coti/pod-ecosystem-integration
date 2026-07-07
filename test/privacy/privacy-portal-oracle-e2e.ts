import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseUnits } from "viem";
import { MANUAL_USD_PEG_18 } from "../../scripts/privacyPortal/oracle-pegs.js";
import { oracleTokensForChain } from "../../scripts/oracle-tokens.js";
import {
  DEFAULT_POD_FEE,
  RECIPIENT,
  deployDirectPortalContext,
  deployPortalFactory,
} from "./privacy-portal-utils.js";
import { expectedDynamicPortalFee } from "./oracle-test-utils.js";

const ETH_USD_8DEC = 2_000_00000000n;
const NATIVE_USD_18 = parseUnits("2000", 18);
const DEPOSIT_AMOUNT = 1_000_000n;
const FIXED_FEE = 1n;
const FEE_BPS = 5_000n;
const MAX_FEE = 1_000_000_000_000_000n;

describe("Privacy Portal oracle fees", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;
  const client = { public: publicClient, wallet };
  const { localToken, portalNative } = oracleTokensForChain(31337);

  it("manual collateral peg + live native feed: estimate matches and fee is enforced on deposit", async function () {
    const ctx = await deployDirectPortalContext({ viem, publicClient, wallet, owner });

    const ethFeed = await viem.deployContract("MockChainlinkAggregator", [8, ETH_USD_8DEC], { client });
    const liveAdapter = await viem.deployContract("ChainlinkLiveOracle", [owner, 3600n], { client });
    await liveAdapter.write.setFeed([localToken, ethFeed.address], { account: owner });
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, liveAdapter.address, 0n], { client });
    await oracle.write.setInboxTokens([localToken, oracleTokensForChain(31337).remoteToken], { account: owner });

    const underlying = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6], { client });
    await oracle.write.setTokenPriceUSD([underlying.address, MANUAL_USD_PEG_18], { account: owner });

    const { factory } = await deployPortalFactory(ctx, {
      priceOracle: oracle.address,
      depositFixedFee: FIXED_FEE,
      depositPercentageBps: FEE_BPS,
      depositMaxFee: MAX_FEE,
    });

    const portalImpl = await viem.deployContract("PrivacyPortal", [], { client });
    const cloneHelper = await viem.deployContract("CloneHelper", [], { client });
    await cloneHelper.write.clone([portalImpl.address], { account: owner });
    const portalAddr = (await cloneHelper.read.lastClone()) as `0x${string}`;
    const portal = await viem.getContractAt("PrivacyPortal", portalAddr, { client });
    const pToken = await viem.deployContract("MockPodERC20ForPortal", [], { client });
    await portal.write.initialize([owner, underlying.address, pToken.address, 6, false], { account: owner });
    await portal.write.setPauseController([factory.address], { account: owner });

    const expected = expectedDynamicPortalFee({
      amount: DEPOSIT_AMOUNT,
      decimals: 6,
      collateralUsd: MANUAL_USD_PEG_18,
      nativeUsd: NATIVE_USD_18,
      fixedFee: FIXED_FEE,
      bps: FEE_BPS,
      maxFee: MAX_FEE,
    });

    const [factoryFee, factoryDynamic] = await factory.read.estimateDepositPortalFee([
      underlying.address,
      DEPOSIT_AMOUNT,
      6,
    ]);
    const [portalFee, portalDynamic] = await portal.read.estimateDepositFees([DEPOSIT_AMOUNT]);
    const [floor] = await factory.read.getDepositPortalFeeFloor([
      underlying.address,
      DEPOSIT_AMOUNT,
      6,
    ]);

    assert.equal(factoryFee, expected);
    assert.equal(portalFee, expected);
    assert.equal(floor, expected);
    assert.equal(factoryDynamic, true);
    assert.equal(portalDynamic, true);
    assert.equal(await oracle.read.getLivePrice([underlying.address]), MANUAL_USD_PEG_18);
    assert.equal(await factory.read.nativeToken(), portalNative);

    await underlying.write.mint([owner, DEPOSIT_AMOUNT * 2n], { account: owner });
    await underlying.write.approve([portalAddr, DEPOSIT_AMOUNT * 2n], { account: owner });

    await portal.write.deposit([RECIPIENT, DEPOSIT_AMOUNT, factoryFee, 77n], {
      account: owner,
      value: DEFAULT_POD_FEE + factoryFee,
    });
    assert.equal(await portal.read.accumulatedPortalFees(), factoryFee);

    await assert.rejects(
      portal.write.deposit([RECIPIENT, DEPOSIT_AMOUNT, factoryFee - 1n, 77n], {
        account: owner,
        value: DEFAULT_POD_FEE + factoryFee - 1n,
      }),
      /InsufficientPortalFee/
    );
  });
});
