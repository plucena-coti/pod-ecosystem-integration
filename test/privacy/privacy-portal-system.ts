/**
 * Cross-chain Privacy Portal system tests (Hardhat/Sepolia ↔ COTI).
 *
 * Covers deploy wiring, deposit (underlying → pToken mint), withdraw (permit + transferAndCall + burn),
 * and direct pToken actions (transfer, approve/transferFrom, burn) plus multi-step flows.
 *
 * Run: `npm run test:pp-system` (sets `PP_SYSTEM_TESTS=1` and `COTI_BACKEND=sim`).
 * Override with live COTI: `COTI_BACKEND=live npm run test:pp-system`.
 * Step logs use `[mpc-test] privacy-portal-system: …` — grep that prefix to follow phases.
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { collectInboxFeesAfterTest, logStep, podTwoWayWriteOptions } from "../system/mpc-test-utils.js";
import { connectDualChainForTests } from "../sim-coti/sim-coti-utils.js";
import {
  assertPortalWiring,
  completePodOpRoundTrip,
  depositAndComplete,
  fundUnderlyingForDeposit,
  ppLog,
  readDecryptedAllowance,
  readDecryptedBalance,
  seedZeroBalanceOnPod,
  setupPrivacyPortalSystemContext,
  withdrawAndComplete,
  type PrivacyPortalSystemContext,
} from "./privacy-portal-system-utils.js";

const runPpSystem = process.env.PP_SYSTEM_TESTS === "1";
const d = runPpSystem ? describe : describe.skip;

if (!runPpSystem) {
  logStep(
    'privacy-portal-system: suite skipped — PP_SYSTEM_TESTS is not "1". Use: npm run test:pp-system'
  );
}

d("PrivacyPortal (Sepolia ↔ COTI system)", { concurrency: 1 }, async function () {
  // COTI_BACKEND=sim → in-process simCoti; otherwise live cotiTestnet.
  const { sepoliaViem, cotiViem } = await connectDualChainForTests();

  let ctx: PrivacyPortalSystemContext;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx.base);
  });

  before(async function () {
    ppLog("before: connecting networks and deploying PP stack (portal, pToken, mother)");
    if (process.env.COTI_REUSE_CONTRACTS === undefined) {
      process.env.COTI_REUSE_CONTRACTS = "false";
    }
    ctx = await setupPrivacyPortalSystemContext({ sepoliaViem, cotiViem });

    ppLog("before: seed zero ciphertext for owner and Bob (valid balanceOf decrypt)");
    await seedZeroBalanceOnPod(ctx, ctx.owner, "seedOwnerZero");
    await seedZeroBalanceOnPod(ctx, ctx.bob.address, "seedBobZero");
    ppLog(`before: ready (owner=${ctx.owner}, bob=${ctx.bob.address})`);
  });

  it("deploy: portal, pToken, and COTI mother are wired correctly", async function () {
    ppLog("case deploy-wiring: assert portal ↔ pToken ↔ mother registration");
    await assertPortalWiring(ctx);
    ppLog("case deploy-wiring: done");
  });

  it("deposit: locks underlying and mints pTokens to recipient", async function () {
    ppLog("case deposit: start");
    const amount = 10_000n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const vaultBefore = (await ctx.underlying.read.balanceOf([ctx.portal.address])) as bigint;

    await fundUnderlyingForDeposit(ctx, amount);
    await depositAndComplete(ctx, amount, { recipient: ctx.owner, label: "depositMint" });

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + amount);
    assert.equal((await ctx.underlying.read.balanceOf([ctx.portal.address])) as bigint, vaultBefore + amount);
    ppLog("case deposit: done (vault locked, pToken balance increased)");
  });

  it("withdraw: permit path releases underlying and burns pTokens", async function () {
    ppLog("case withdraw: start");
    const depositAmt = 8_000n;
    const withdrawAmt = 3_500n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const recipientBefore = (await ctx.underlying.read.balanceOf([ctx.withdrawRecipient])) as bigint;

    await fundUnderlyingForDeposit(ctx, depositAmt);
    await depositAndComplete(ctx, depositAmt, { recipient: ctx.owner, label: "withdrawFund" });
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + depositAmt);

    await withdrawAndComplete(ctx, withdrawAmt, { label: "withdrawRelease" });

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + depositAmt - withdrawAmt);
    assert.equal(
      (await ctx.underlying.read.balanceOf([ctx.withdrawRecipient])) as bigint,
      recipientBefore + withdrawAmt
    );
    assert.equal((await ctx.portal.read.pendingBurnAmount()) as bigint, 0n);
    ppLog("case withdraw: done (underlying released, pToken batch-burned, no pending burn)");
  });

  it("pToken transfer: public transfer owner → Bob after deposit", async function () {
    ppLog("case pToken-transfer: start");
    const depositAmt = 6_000n;
    const sendAmt = 2_200n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);

    await fundUnderlyingForDeposit(ctx, depositAmt);
    await depositAndComplete(ctx, depositAmt, { recipient: ctx.owner, label: "xferFund" });

    ppLog(`case pToken-transfer: transfer ${sendAmt} owner → bob`);
    await completePodOpRoundTrip(ctx, "ppXfer", () =>
      ctx.podAsCoti.write.transfer(
        [ctx.bob.address, sendAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + depositAmt - sendAmt);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + sendAmt);
    ppLog("case pToken-transfer: done");
  });

  it("pToken allowance: approve + transferFrom after deposit", async function () {
    ppLog("case pToken-allowance: start");
    const depositAmt = 7_500n;
    const allowanceAmt = 4_000n;
    const spendAmt = 1_800n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);

    await fundUnderlyingForDeposit(ctx, depositAmt);
    await depositAndComplete(ctx, depositAmt, { recipient: ctx.owner, label: "apprFund" });

    ppLog(`case pToken-allowance: approve self ${allowanceAmt}`);
    await completePodOpRoundTrip(ctx, "ppAppr", () =>
      ctx.podAsCoti.write.approve(
        [ctx.owner, allowanceAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );
    const dec = await readDecryptedAllowance(ctx, ctx.owner, ctx.owner);
    assert.equal(dec.ownerCt, allowanceAmt);

    ppLog(`case pToken-allowance: transferFrom owner → bob spend=${spendAmt}`);
    await completePodOpRoundTrip(ctx, "ppXferFrom", () =>
      ctx.podAsCoti.write.transferFrom(
        [ctx.owner, ctx.bob.address, spendAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + depositAmt - spendAmt);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + spendAmt);
    ppLog("case pToken-allowance: done");
  });

  it("pToken burn: public burn reduces balance after deposit", async function () {
    ppLog("case pToken-burn: start");
    const depositAmt = 5_000n;
    const burnAmt = 1_100n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);

    await fundUnderlyingForDeposit(ctx, depositAmt);
    await depositAndComplete(ctx, depositAmt, { recipient: ctx.owner, label: "burnFund" });

    ppLog(`case pToken-burn: burn ${burnAmt}`);
    await completePodOpRoundTrip(ctx, "ppBurn", () =>
      ctx.podAsCoti.write.burn(
        [burnAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + depositAmt - burnAmt);
    ppLog("case pToken-burn: done");
  });

  it("multi-step: deposit → transfer to Bob → partial withdraw", async function () {
    ppLog("case multi xfer+withdraw: start");
    const depositAmt = 12_000n;
    const transferAmt = 4_500n;
    const withdrawAmt = 2_000n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);
    const recipientBefore = (await ctx.underlying.read.balanceOf([ctx.withdrawRecipient])) as bigint;

    await fundUnderlyingForDeposit(ctx, depositAmt);
    await depositAndComplete(ctx, depositAmt, { recipient: ctx.owner, label: "multiFund" });

    await completePodOpRoundTrip(ctx, "multiXfer", () =>
      ctx.podAsCoti.write.transfer(
        [ctx.bob.address, transferAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + transferAmt);

    await withdrawAndComplete(ctx, withdrawAmt, { label: "multiWithdraw" });

    assert.equal(
      await readDecryptedBalance(ctx, ctx.owner),
      ownerBefore + depositAmt - transferAmt - withdrawAmt
    );
    assert.equal(
      (await ctx.underlying.read.balanceOf([ctx.withdrawRecipient])) as bigint,
      recipientBefore + withdrawAmt
    );
    ppLog("case multi xfer+withdraw: done");
  });

  it("multi-step: deposit → approve → transferFrom → withdraw remainder", async function () {
    ppLog("case multi appr+xferFrom+withdraw: start");
    const depositAmt = 9_000n;
    const allowanceAmt = 5_000n;
    const spendAmt = 2_500n;
    const withdrawAmt = 1_000n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);

    await fundUnderlyingForDeposit(ctx, depositAmt);
    await depositAndComplete(ctx, depositAmt, { recipient: ctx.owner, label: "flowFund" });

    await completePodOpRoundTrip(ctx, "flowAppr", () =>
      ctx.podAsCoti.write.approve(
        [ctx.owner, allowanceAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );
    await completePodOpRoundTrip(ctx, "flowXferFrom", () =>
      ctx.podAsCoti.write.transferFrom(
        [ctx.owner, ctx.bob.address, spendAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    const remainder = depositAmt - spendAmt - withdrawAmt;
    await withdrawAndComplete(ctx, withdrawAmt, { label: "flowWithdraw" });

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + remainder);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + spendAmt);
    ppLog("case multi appr+xferFrom+withdraw: done");
  });

  it("multi-step: two deposits accumulate pToken balance", async function () {
    ppLog("case multi-deposit: start");
    const first = 3_000n;
    const second = 2_500n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const vaultBefore = (await ctx.underlying.read.balanceOf([ctx.portal.address])) as bigint;

    await fundUnderlyingForDeposit(ctx, first + second);
    await depositAndComplete(ctx, first, { recipient: ctx.owner, label: "depositA" });
    await depositAndComplete(ctx, second, { recipient: ctx.owner, label: "depositB" });

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + first + second);
    assert.equal(
      (await ctx.underlying.read.balanceOf([ctx.portal.address])) as bigint,
      vaultBefore + first + second
    );
    ppLog("case multi-deposit: done");
  });
});
