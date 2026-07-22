/**
 * Cross-chain `PodERC20` + `PodErc20CotiMother` tests (mint/sync, transfer, approve, pending, errors).
 *
 * These exercises COTI MPC on garbled 256-bit balances (`syncBalances` uses `offBoardToUser` per account). If
 * `batchProcessRequests` fails, try raising `COTI_MINE_GAS_POD_TOKEN`.
 *
 * Run explicitly: `npm run test:pod-token` (sets `POD_TOKEN_SYSTEM_TESTS=1` and `COTI_BACKEND=sim`).
 * Override with live COTI: `COTI_BACKEND=live npm run test:pod-token` (or unset / any non-sim value).
 * Running `hardhat test test/tokens/pod-token.ts` without that env skips the whole suite (`-` in node:test output);
 * skipped suites do not run `before` or `it`, so there are no step logs unless you enable the flag.
 *
 * Step logs use `[mpc-test] pod-token: …` (see `pt()`); grep `pod-token` in the test output to follow phases.
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { decodeAbiParameters, encodeFunctionData } from "viem";
import { logStep } from "../system/mpc-test-utils.js";
import { connectDualChainForTests } from "../sim-coti/sim-coti-utils.js";
import {
  assertIncludesInsensitive,
  completePodOpRoundTrip,
  encryptAmount,
  encryptAmountAsBob,
  mineOutboundRoundTripForRequest,
  mintOnCoti,
  mintOnCotiAndSync,
  syncPodBalancesRoundTrip,
  readAllowanceWithPending,
  readBalanceWithPending,
  readDecryptedAllowance,
  readDecryptedBalance,
  setupPodTokenTestContext,
  utf8FromFailedRequestBytes,
  type PodTokenTestContext,
} from "./test-token-utils.js";
import {
  collectInboxFeesAfterTest,
  getLatestRequest,
  podTwoWayWriteOptions,
} from "../system/mpc-test-utils.js";

const runPodTokenSystem = process.env.POD_TOKEN_SYSTEM_TESTS === "1";
const d = runPodTokenSystem ? describe : describe.skip;

if (!runPodTokenSystem) {
  logStep(
    "pod-token: suite skipped — POD_TOKEN_SYSTEM_TESTS is not \"1\", so `before`/tests never run and no step logs appear. Use: npm run test:pod-token"
  );
}

/** Step log for this suite (grep `pod-token`). */
const pt = (message: string) => logStep(`pod-token: ${message}`);

d("PodERC20 (cross-chain token)", { concurrency: 1 }, async function () {
  // COTI_BACKEND=sim → in-process simCoti; otherwise live cotiTestnet.
  const { sepoliaViem, cotiViem } = await connectDualChainForTests();

  let ctx: PodTokenTestContext;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx.base);
  });

  before(async function () {
    pt("before: connecting networks and deploying PodERC20 + PodErc20CotiMother");
    // Fresh COTI inbox + mother registration avoids stale `raise`/nonce state vs newly deployed namespaces.
    if (process.env.COTI_REUSE_CONTRACTS === undefined) {
      process.env.COTI_REUSE_CONTRACTS = "false";
    }
    ctx = await setupPodTokenTestContext({ sepoliaViem, cotiViem });
    pt("before: seed Bob on COTI + sync so PoD balanceOf(Bob) is valid zero ciphertext (not uninitialized storage)");
    await syncPodBalancesRoundTrip(ctx, [ctx.bob.address], "seedBobZero");
    pt(`before: ready (owner=${ctx.owner}, bob=${ctx.bob.address}, pod=${ctx.pod.address})`);
  });

  it("mint on COTI + sync on PoD updates balances", async function () {
    pt("case mint+sync: start");
    const amount = 10_000n;
    pt(`case mint+sync: mintOnCotiAndSync owner amount=${amount}`);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount }], "mintSyncOwner");

    pt("case mint+sync: read decrypted balance + pending flag");
    const bal = await readDecryptedBalance(ctx, ctx.owner);
    assert.equal(bal, amount);
    const st = await readBalanceWithPending(ctx, ctx.owner);
    assert.equal(st.pending, false);
    pt("case mint+sync: done (balance matches, not pending)");
  });

  it("simple transfer: round-trip updates sender and receiver balances", async function () {
    pt("case simple transfer: start");
    const start = 5_000n;
    const sendAmt = 1_200n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);
    pt(`case simple transfer: fund owner with ${start}`);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "xferFund");
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + start);

    pt(`case simple transfer: encrypt ${sendAmt} and run transfer round-trip`);
    const itAmount = await encryptAmount(ctx, sendAmt);
    await completePodOpRoundTrip(ctx, "xferSimple", () =>
      ctx.podAsCoti.write.transfer([ctx.bob.address, itAmount, ctx.base.podTwoWayFees.callbackFeeWei], podTwoWayWriteOptions(ctx.base.podTwoWayFees))
    );

    pt("case simple transfer: assert owner and bob balances");
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + start - sendAmt);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + sendAmt);
    pt("case simple transfer: done");
  });

  it("approve then transferFrom updates balances and allowance", async function () {
    pt("case approve+transferFrom: start");
    const start = 8_000n;
    const allowanceAmt = 3_000n;
    const spendAmt = 2_000n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);
    pt(`case approve+transferFrom: fund owner ${start}`);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "apprFund");
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + start);

    const itAllow = await encryptAmount(ctx, allowanceAmt);
    let ap = await readAllowanceWithPending(ctx, ctx.owner, ctx.owner);
    assert.equal(ap.pending, false);
    pt(`case approve+transferFrom: approve self allowance=${allowanceAmt}`);
    await completePodOpRoundTrip(ctx, "apprSelf", () =>
      ctx.podAsCoti.write.approve([ctx.owner, itAllow, ctx.base.podTwoWayFees.callbackFeeWei], podTwoWayWriteOptions(ctx.base.podTwoWayFees))
    );

    ap = await readAllowanceWithPending(ctx, ctx.owner, ctx.owner);
    assert.equal(ap.pending, false);
    const dec = await readDecryptedAllowance(ctx, ctx.owner, ctx.owner);
    assert.equal(dec.ownerCt, allowanceAmt);
    assert.equal(dec.spenderCt, allowanceAmt);
    pt("case approve+transferFrom: allowance ciphertexts match");

    pt(`case approve+transferFrom: transferFrom owner→bob spend=${spendAmt}`);
    const itSpend = await encryptAmount(ctx, spendAmt);
    await completePodOpRoundTrip(ctx, "xferFrom", () =>
      ctx.podAsCoti.write.transferFrom(
        [ctx.owner, ctx.bob.address, itSpend, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + start - spendAmt);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + spendAmt);
    // Allowance is not reduced on the PoD mirror today (`PodErc20CotiMother.transferFrom` does not touch garbled allowance);
    // balances above confirm approve + transferFrom round-trips succeeded.
    const after = await readDecryptedAllowance(ctx, ctx.owner, ctx.owner);
    assert.equal(after.ownerCt, allowanceAmt);
    assert.equal(after.spenderCt, allowanceAmt);
    pt("case approve+transferFrom: done (PoD allowance mirror unchanged as expected)");
  });

  // Concurrent in-flight transfers need ordered mining + careful fee escrow; currently flakes on the
  // Hardhat callback leg (`errorCode=1`) and leaves TargetFeeTooLow for later cases. Covered separately.
  it.skip("allows transfer to a recipient while they are not sender-pending (receiver not locked)", async function () {
    pt("case receiver not locked: start");
    const start = 5_000n;
    const ownerToBob = 100n;
    const bobToOwner = 50n;
    pt(`case receiver not locked: fund owner=${start} bob=${start}`);
    await mintOnCotiAndSync(ctx, [
      { address: ctx.owner, amount: start },
      { address: ctx.bob.address, amount: start },
    ], "recvNotLockedFund");

    pt("case receiver not locked: owner -> bob (PoD only, not mined yet)");
    const itOwnerSend = await encryptAmount(ctx, ownerToBob);
    const ownerTx = await ctx.podAsCoti.write.transfer(
      [ctx.bob.address, itOwnerSend, ctx.base.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.base.podTwoWayFees)
    );
    await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash: ownerTx });
    const ownerOutbound = await getLatestRequest(ctx.base.contracts.inboxSepolia, ctx.base.chainIds.coti);
    const ownerMid = await readBalanceWithPending(ctx, ctx.owner);
    const bobMid = await readBalanceWithPending(ctx, ctx.bob.address);
    assert.equal(ownerMid.pending, true);
    assert.equal(bobMid.pending, false);
    pt("case receiver not locked: bob -> owner should succeed while owner->bob is in flight");

    // Pad fee value: a second in-flight two-way can need a slightly higher target-fee slice than the
    // setup-time estimate (Hardhat base fee drift / concurrent escrow).
    const bobFeeOpts = {
      ...podTwoWayWriteOptions(ctx.base.podTwoWayFees),
      value: ctx.base.podTwoWayFees.totalValueWei + ctx.base.podTwoWayFees.totalValueWei / 10n,
    };
    const itBobSend = await encryptAmountAsBob(ctx, bobToOwner);
    const bobTx = await ctx.podAsBob.write.transfer(
      [ctx.owner, itBobSend, ctx.base.podTwoWayFees.callbackFeeWei],
      bobFeeOpts
    );
    await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash: bobTx });
    const bobOutbound = await getLatestRequest(ctx.base.contracts.inboxSepolia, ctx.base.chainIds.coti);
    const bobAfter = await readBalanceWithPending(ctx, ctx.bob.address);
    assert.equal(bobAfter.pending, true);

    pt("case receiver not locked: mine both round-trips in nonce order (older first)");
    await mineOutboundRoundTripForRequest(ctx, ownerOutbound, "recvNotLockedMineOwner");
    await mineOutboundRoundTripForRequest(ctx, bobOutbound, "recvNotLockedMineBob");

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), start - ownerToBob + bobToOwner);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), start + ownerToBob - bobToOwner);
    pt("case receiver not locked: done");
  });

  it("allows concurrent transfers while pendingTransferCount is in flight", async function () {
    pt("case concurrent pending: start");
    const start = 4_000n;
    const firstAmt = 100n;
    const secondAmt = 200n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    pt(`case concurrent pending: fund owner ${start}`);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "pendFund");
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + start);

    pt("case concurrent pending: submit first transfer (PoD only, not mined yet on COTI)");
    const itSmall = await encryptAmount(ctx, firstAmt);
    const firstTx = await ctx.podAsCoti.write.transfer(
      [ctx.bob.address, itSmall, ctx.base.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.base.podTwoWayFees)
    );
    await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash: firstTx });
    const firstOutbound = await getLatestRequest(ctx.base.contracts.inboxSepolia, ctx.base.chainIds.coti);

    const mid = await readBalanceWithPending(ctx, ctx.owner);
    assert.equal(mid.pending, true);
    assert.equal(await ctx.pod.read.pendingTransferCount([ctx.owner]), 1n);
    pt("case concurrent pending: owner pendingTransferCount=1, second transfer should succeed");

    // Pad fee value: a second in-flight two-way can need a slightly higher target-fee slice than the
    // setup-time estimate (Hardhat base fee drift / concurrent escrow).
    const secondFeeOpts = {
      ...podTwoWayWriteOptions(ctx.base.podTwoWayFees),
      value: ctx.base.podTwoWayFees.totalValueWei + ctx.base.podTwoWayFees.totalValueWei / 10n,
    };
    const itAnother = await encryptAmount(ctx, secondAmt);
    const secondTx = await ctx.podAsCoti.write.transfer(
      [ctx.bob.address, itAnother, ctx.base.podTwoWayFees.callbackFeeWei],
      secondFeeOpts
    );
    await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash: secondTx });
    const secondOutbound = await getLatestRequest(ctx.base.contracts.inboxSepolia, ctx.base.chainIds.coti);

    assert.equal(await ctx.pod.read.pendingTransferCount([ctx.owner]), 2n);
    const mid2 = await readBalanceWithPending(ctx, ctx.owner);
    assert.equal(mid2.pending, true);
    pt("case concurrent pending: pendingTransferCount=2, mine both round-trips in order");

    await mineOutboundRoundTripForRequest(ctx, firstOutbound, "pendClearFirst");
    assert.equal(await ctx.pod.read.pendingTransferCount([ctx.owner]), 1n);
    await mineOutboundRoundTripForRequest(ctx, secondOutbound, "pendClearSecond");

    const end = await readBalanceWithPending(ctx, ctx.owner);
    assert.equal(end.pending, false);
    assert.equal(await ctx.pod.read.pendingTransferCount([ctx.owner]), 0n);
    assert.equal(end.balance, ownerBefore + start - firstAmt - secondAmt);
    pt("case concurrent pending: done (both settled, count=0, balance reduced by 300)");
  });

  it("encrypted insufficient transfer succeeds as no-op without distinct failure", async function () {
    pt("case encrypted insufficient: start (PP-04 mux path)");
    const start = 500n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);
    pt(`case encrypted insufficient: fund owner ${start}, then attempt transfer > balance`);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "encInsufFund");
    const ownerAfterMint = await readDecryptedBalance(ctx, ctx.owner);
    assert.equal(ownerAfterMint, ownerBefore + start);

    const tooMuch = ownerAfterMint + 1n;
    pt(`case encrypted insufficient: attempt ${tooMuch} (> balance ${ownerAfterMint})`);
    const itAmount = await encryptAmount(ctx, tooMuch);
    pt("case encrypted insufficient: round-trip (expect Success no-op, no raise)");
    const { cotiIncomingRequestId } = await completePodOpRoundTrip(ctx, "encInsufXfer", () =>
      ctx.podAsCoti.write.transfer([ctx.bob.address, itAmount, ctx.base.podTwoWayFees.callbackFeeWei], podTwoWayWriteOptions(ctx.base.podTwoWayFees))
    );

    const st = await readBalanceWithPending(ctx, ctx.owner);
    assert.equal(st.pending, false);
    const ownerAfter = await readDecryptedBalance(ctx, ctx.owner);
    assert.equal(ownerAfter, ownerAfterMint);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore);
    const status = await ctx.pod.read.requests([cotiIncomingRequestId]);
    // RequestStatus.Success
    assert.equal(Number(status.status), 2);
    const errHex = (await ctx.pod.read.failedRequests([cotiIncomingRequestId])) as `0x${string}`;
    assert.equal(errHex, "0x");
    pt(`case encrypted insufficient: done (Success no-op, balances unchanged)`);
  });

  it("public insufficient transfer still raises insufficient balance", async function () {
    pt("case public insufficient: start");
    const start = 200n;
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "pubInsufFund");
    const ownerAfterMint = await readDecryptedBalance(ctx, ctx.owner);
    const tooMuch = ownerAfterMint + 1n;
    pt(`case public insufficient: attempt public transfer ${tooMuch}`);
    const { cotiIncomingRequestId } = await completePodOpRoundTrip(ctx, "pubInsufXfer", () =>
      ctx.podAsCoti.write.transfer(
        [ctx.bob.address, tooMuch, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    const st = await readBalanceWithPending(ctx, ctx.owner);
    assert.equal(st.pending, false);
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerAfterMint);
    const errHex = (await ctx.pod.read.failedRequests([cotiIncomingRequestId])) as `0x${string}`;
    const text = utf8FromFailedRequestBytes(errHex);
    assertIncludesInsensitive(text, "insufficient");
    pt(`case public insufficient: done (error text includes "insufficient")`);
  });

  it("bad encryption transfer: SystemFailed clears pending, balance unchanged, then good transfer succeeds", async function () {
    pt("case bad-enc transfer: start");
    const start = 400n;
    const sendAmt = 100n;
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "badEncXferFund");
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);

    // Encrypt+sign with Bob, but submit the PoD transfer as the owner (tx.origin on COTI mine ≠ Bob).
    const itBad = await encryptAmountAsBob(ctx, sendAmt);
    pt("case bad-enc transfer: round-trip with mismatched it* signer (system error)");
    const { cotiIncomingRequestId } = await completePodOpRoundTrip(ctx, "badEncXfer", () =>
      ctx.podAsCoti.write.transfer(
        [ctx.bob.address, itBad, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    const st = await readBalanceWithPending(ctx, ctx.owner);
    assert.equal(st.pending, false, "wallet must leave pending after SystemFailed");
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore);

    const status = await ctx.pod.read.requests([cotiIncomingRequestId]);
    assert.equal(Number(status.status), 4); // RequestStatus.SystemFailed
    const errHex = (await ctx.pod.read.failedRequests([cotiIncomingRequestId])) as `0x${string}`;
    const [code] = decodeAbiParameters([{ type: "uint64" }, { type: "bytes" }], errHex);
    assert.equal(code, 2n); // ERROR_CODE_ENCODE_FAILED
    pt("case bad-enc transfer: SystemFailed cleared pending; balances unchanged");

    pt("case bad-enc transfer: retry with correct encryption");
    const itGood = await encryptAmount(ctx, sendAmt);
    await completePodOpRoundTrip(ctx, "badEncXferRetry", () =>
      ctx.podAsCoti.write.transfer(
        [ctx.bob.address, itGood, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    const after = await readBalanceWithPending(ctx, ctx.owner);
    assert.equal(after.pending, false);
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore - sendAmt);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + sendAmt);
    pt("case bad-enc transfer: done (retry succeeded, balances updated)");
  });

  it("bad encryption approve: SystemFailed clears allowance pending, then good approve succeeds", async function () {
    pt("case bad-enc approve: start");
    const allowanceAmt = 250n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);

    // Ensure allowance slot is not pending before the bad approve.
    let ap = await readAllowanceWithPending(ctx, ctx.owner, ctx.bob.address);
    assert.equal(ap.pending, false);

    const itBad = await encryptAmountAsBob(ctx, allowanceAmt);
    pt("case bad-enc approve: round-trip with mismatched it* signer (system error)");
    const { cotiIncomingRequestId } = await completePodOpRoundTrip(ctx, "badEncAppr", () =>
      ctx.podAsCoti.write.approve(
        [ctx.bob.address, itBad, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    ap = await readAllowanceWithPending(ctx, ctx.owner, ctx.bob.address);
    assert.equal(ap.pending, false, "allowance must leave pending after SystemFailed");
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore);

    const status = await ctx.pod.read.requests([cotiIncomingRequestId]);
    assert.equal(Number(status.status), 4); // RequestStatus.SystemFailed
    const errHex = (await ctx.pod.read.failedRequests([cotiIncomingRequestId])) as `0x${string}`;
    const [code] = decodeAbiParameters([{ type: "uint64" }, { type: "bytes" }], errHex);
    assert.equal(code, 2n); // ERROR_CODE_ENCODE_FAILED
    pt("case bad-enc approve: SystemFailed cleared pending");

    pt("case bad-enc approve: retry with correct encryption");
    const itGood = await encryptAmount(ctx, allowanceAmt);
    await completePodOpRoundTrip(ctx, "badEncApprRetry", () =>
      ctx.podAsCoti.write.approve(
        [ctx.bob.address, itGood, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    ap = await readAllowanceWithPending(ctx, ctx.owner, ctx.bob.address);
    assert.equal(ap.pending, false);
    const dec = await readDecryptedAllowance(ctx, ctx.owner, ctx.bob.address);
    assert.equal(dec.ownerCt, allowanceAmt);
    assert.equal(dec.spenderCt, allowanceAmt);
    pt("case bad-enc approve: done (retry succeeded, allowance updated)");
  });

  // Matches `MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI` in `test/system/mpc-test-utils.ts` (InboxFeeManager.DEFAULT_GAS_PRICE).
  // When we pin `gasPrice` on an auto-fee tx to this value, the inbox's runtime reference gas price equals the
  // price used by `estimateGas` in setup, so the contract's internal `_estimateTwoWayFeeInLocalToken()` produces
  // the exact same (target, caller) split.
  const FEE_CALC_GAS_PRICE_WEI = 2_000_000_000n;
  const FEE_EST_REMOTE_CALL_SIZE = 512n;
  const FEE_EST_CALLBACK_CALL_SIZE = 512n;
  const FEE_EST_REMOTE_EXEC_GAS = 300_000n;
  const FEE_EST_CALLBACK_EXEC_GAS = 300_000n;
  /** Small pad that absorbs mulDiv rounding in `calculateTwoWayFeeRequiredInLocalToken` vs `validateAndPrepareTwoWayFees`. */
  const paddedPodFee = (x: bigint) => x + x / 100n + 1n;

  it("estimateFee matches inbox.calculateTwoWayFeeRequiredInLocalToken for the auto-fee constants", async function () {
    pt("case estimateFee: start");
    const [targetWei, callerWei] = (await ctx.base.contracts.inboxSepolia.read.calculateTwoWayFeeRequiredInLocalToken([
      FEE_EST_REMOTE_CALL_SIZE,
      FEE_EST_CALLBACK_CALL_SIZE,
      FEE_EST_REMOTE_EXEC_GAS,
      FEE_EST_CALLBACK_EXEC_GAS,
      FEE_CALC_GAS_PRICE_WEI,
    ])) as [bigint, bigint];
    pt(`case estimateFee: inbox target=${targetWei} caller=${callerWei}`);
    assert.ok(targetWei > 0n, "targetWei must be non-zero");
    assert.ok(callerWei > 0n, "callerWei must be non-zero");
    // `estimateFee()` uses `tx.gasprice`; in plain `eth_call` that is 0, so `calculateTwoWayFeeRequiredInLocalToken`
    // returns (0, 0). Override the call-level `gasPrice` so the view sees the same tx.gasprice as the helper above
    // and `_estimateTwoWayFeeInLocalToken` produces the exact same (target, callback) split.
    const estimateFeeAbi = [
      {
        type: "function",
        name: "estimateFee",
        stateMutability: "view",
        inputs: [],
        outputs: [
          { name: "totalFeeWei", type: "uint256" },
          { name: "targetFeeWei", type: "uint256" },
          { name: "callbackFeeWei", type: "uint256" },
        ],
      },
    ] as const;
    const callResult = await ctx.base.sepolia.publicClient.call({
      to: ctx.pod.address as `0x${string}`,
      data: encodeFunctionData({ abi: estimateFeeAbi, functionName: "estimateFee" }),
      gasPrice: FEE_CALC_GAS_PRICE_WEI,
    });
    const rawData = (callResult?.data ?? "0x") as `0x${string}`;
    const [total, target, callback] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      rawData
    ) as [bigint, bigint, bigint];
    pt(`case estimateFee: contract total=${total} target=${target} callback=${callback}`);
    assert.equal(target, targetWei, "contract target fee must match inbox calculation");
    assert.equal(callback, callerWei, "contract callback fee must match inbox calculation");
    assert.equal(total, targetWei + callerWei, "total must equal target + callback");
    pt("case estimateFee: done (internal estimator matches inbox helper exactly)");
  });

  it("auto-fee transfer: contract computes callback fee internally and round-trips", async function () {
    pt("case auto-fee transfer: start");
    const start = 3_500n;
    const sendAmt = 900n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);
    pt(`case auto-fee transfer: fund owner with ${start}`);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "autoXferFund");

    const [targetWei, callerWei] = (await ctx.base.contracts.inboxSepolia.read.calculateTwoWayFeeRequiredInLocalToken([
      FEE_EST_REMOTE_CALL_SIZE,
      FEE_EST_CALLBACK_CALL_SIZE,
      FEE_EST_REMOTE_EXEC_GAS,
      FEE_EST_CALLBACK_EXEC_GAS,
      FEE_CALC_GAS_PRICE_WEI,
    ])) as [bigint, bigint];
    // Add 1% pad: `calculateTwoWayFeeRequiredInLocalToken` rounds target down in mulDiv (remote→local), and
    // `validateAndPrepareTwoWayFees` rounds again (local→remote), so equality at the boundary can fail by a few units.
    const totalValue = paddedPodFee(targetWei + callerWei);
    pt(`case auto-fee transfer: inbox target=${targetWei} caller=${callerWei} totalPadded=${totalValue}`);

    const itAmount = await encryptAmount(ctx, sendAmt);
    await completePodOpRoundTrip(ctx, "autoXfer", () =>
      ctx.podAsCoti.write.transfer([ctx.bob.address, itAmount], {
        value: totalValue,
        gasPrice: FEE_CALC_GAS_PRICE_WEI,
        gas: 8_000_000n,
      })
    );

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + start - sendAmt);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + sendAmt);
    pt("case auto-fee transfer: done (succeeded with msg.value = inbox-derived totalExact)");
  });

  it("auto-fee transfer reverts when msg.value is below the contract's internal estimate", async function () {
    pt("case auto-fee insufficient value: start");
    const itAmount = await encryptAmount(ctx, 1n);
    await assert.rejects(
      () =>
        ctx.podAsCoti.write.transfer([ctx.bob.address, itAmount], {
          value: 1n,
          gasPrice: FEE_CALC_GAS_PRICE_WEI,
        }),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        return /PodERC20: callback exceeds total|totalFee|value/i.test(msg);
      }
    );
    pt("case auto-fee insufficient value: done");
  });

  it("auto-fee approve: contract computes callback fee internally and round-trips", async function () {
    pt("case auto-fee approve: start");
    const allowanceAmt = 1_500n;
    const [targetWei, callerWei] = (await ctx.base.contracts.inboxSepolia.read.calculateTwoWayFeeRequiredInLocalToken([
      FEE_EST_REMOTE_CALL_SIZE,
      FEE_EST_CALLBACK_CALL_SIZE,
      FEE_EST_REMOTE_EXEC_GAS,
      FEE_EST_CALLBACK_EXEC_GAS,
      FEE_CALC_GAS_PRICE_WEI,
    ])) as [bigint, bigint];
    const totalValue = paddedPodFee(targetWei + callerWei);

    const itAllow = await encryptAmount(ctx, allowanceAmt);
    await completePodOpRoundTrip(ctx, "autoAppr", () =>
      ctx.podAsCoti.write.approve([ctx.bob.address, itAllow], {
        value: totalValue,
        gasPrice: FEE_CALC_GAS_PRICE_WEI,
        gas: 8_000_000n,
      })
    );

    const dec = await readDecryptedAllowance(ctx, ctx.owner, ctx.bob.address);
    assert.equal(dec.ownerCt, allowanceAmt);
    assert.equal(dec.spenderCt, allowanceAmt);
    pt("case auto-fee approve: done");
  });

  it("plain uint256 transfer round-trips balances", async function () {
    pt("case plain transfer: start");
    const start = 2_400n;
    const sendAmt = 700n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "plainXferFund");

    await completePodOpRoundTrip(ctx, "plainXfer", () =>
      ctx.podAsCoti.write.transfer(
        [ctx.bob.address, sendAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + start - sendAmt);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + sendAmt);
    pt("case plain transfer: done");
  });

  it("plain uint256 approve + transferFrom round-trip allowance and balances", async function () {
    pt("case plain approve/transferFrom: start");
    const start = 5_000n;
    const allowanceAmt = 2_100n;
    const spendAmt = 1_300n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "plainApprFund");

    await completePodOpRoundTrip(ctx, "plainAppr", () =>
      ctx.podAsCoti.write.approve(
        [ctx.owner, allowanceAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );
    const dec = await readDecryptedAllowance(ctx, ctx.owner, ctx.owner);
    assert.equal(dec.ownerCt, allowanceAmt);

    await completePodOpRoundTrip(ctx, "plainXferFrom", () =>
      ctx.podAsCoti.write.transferFrom(
        [ctx.owner, ctx.bob.address, spendAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + start - spendAmt);
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + spendAmt);
    pt("case plain approve/transferFrom: done");
  });

  it("plain uint256 burn round-trips balance", async function () {
    pt("case plain burn: start");
    const start = 1_800n;
    const burnAmt = 600n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: start }], "plainBurnFund");

    await completePodOpRoundTrip(ctx, "plainBurn", () =>
      ctx.podAsCoti.write.burn(
        [burnAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + start - burnAmt);
    pt("case plain burn: done");
  });

  it("PodErc20Mintable: minter mints encrypted amount and sync updates PoD", async function () {
    pt("case mint encrypted: start");
    const amount = 7_777n;
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);
    const itAmount = await encryptAmount(ctx, amount);
    await completePodOpRoundTrip(ctx, "mintEncrypted", () =>
      ctx.podAsCoti.write.mint(
        [ctx.bob.address, itAmount, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + amount);
    pt("case mint encrypted: done");
  });

  it("PodErc20Mintable: minter mints plain uint256 and sync updates PoD", async function () {
    pt("case mint plain: start");
    const amount = 4_242n;
    const bobBefore = await readDecryptedBalance(ctx, ctx.bob.address);
    await completePodOpRoundTrip(ctx, "mintPlain", () =>
      ctx.podAsCoti.write.mint(
        [ctx.bob.address, amount, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );
    assert.equal(await readDecryptedBalance(ctx, ctx.bob.address), bobBefore + amount);
    pt("case mint plain: done");
  });

  it("PodErc20Mintable: non-minter mint reverts with OnlyMinter", async function () {
    pt("case OnlyMinter revert: start");
    const nonMinter = ctx.bob.address;
    const rogue = await sepoliaViem.deployContract("PodErc20Mintable", [
      nonMinter,
      ctx.base.chainIds.coti,
      ctx.base.contracts.inboxSepolia.address,
      ctx.podCotiMother.address,
      "Rogue",
      "ROGUE",
    ]);
    const itAmount = await encryptAmount(ctx, 1n);
    await assert.rejects(
      () =>
        rogue.write.mint(
          [ctx.bob.address, itAmount, ctx.base.podTwoWayFees.callbackFeeWei],
          podTwoWayWriteOptions(ctx.base.podTwoWayFees)
        ),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        return msg.includes("OnlyMinter");
      }
    );
    pt("case OnlyMinter revert: done");
  });

  it("base PodERC20 mint reverts with MintNotAllowed", async function () {
    pt("case MintNotAllowed revert: start");
    const basePod = await sepoliaViem.deployContract("PodERC20", [
      ctx.base.chainIds.coti,
      ctx.base.contracts.inboxSepolia.address,
      ctx.podCotiMother.address,
      "Base PoD",
      "BASE",
    ]);
    const itAmount = await encryptAmount(ctx, 1n);
    await assert.rejects(
      () =>
        basePod.write.mint(
          [ctx.bob.address, itAmount, ctx.base.podTwoWayFees.callbackFeeWei],
          podTwoWayWriteOptions(ctx.base.podTwoWayFees)
        ),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        return msg.includes("MintNotAllowed");
      }
    );
    // Plain mint path must revert too.
    await assert.rejects(
      () =>
        basePod.write.mint(
          [ctx.bob.address, 1n, ctx.base.podTwoWayFees.callbackFeeWei],
          podTwoWayWriteOptions(ctx.base.podTwoWayFees)
        ),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        return msg.includes("MintNotAllowed");
      }
    );
    pt("case MintNotAllowed revert: done");
  });
});
