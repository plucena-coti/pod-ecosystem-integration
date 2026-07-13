/**
 * S16–S21 — Extended Sablier coverage
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAbi } from "viem";
import { createSablierPayrollScenario } from "../lib/sablier-scenario.js";
import { admin, employee } from "../lib/actors.js";
import { expectCampaignBalance, expectClaimReverts } from "../lib/assertions.js";
import { spLog } from "../lib/utils.js";

const run = process.env.SABLIER_PAYROLL_TESTS === "1";
const d = run ? describe : describe.skip;

const claimInstantAbi = parseAbi([
  "event ClaimInstant(uint256 indexed index, address indexed recipient, bytes32 amountCommitment, address indexed to, bool viaSig)",
]);

d("S16–S21 extended coverage", { concurrency: 1 }, () => {
  it("S16: ClaimInstant event emitted with public index, recipient, amount", async () => {
    const s = await createSablierPayrollScenario();
    const { tree, campaign } = await s.freshCampaign({
      roster: [{ recipient: s.alice.address, amount: 1_500n }],
    });
    const pkg = tree.packageFor(s.alice.address);
    const result = await employee(s, "alice").claim(pkg, campaign);
    const receipt = await s.publicClient.getTransactionReceipt({ hash: result.txHash });

    const logs = await s.publicClient.getLogs({
      address: campaign.address,
      event: claimInstantAbi[0],
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.index, 0n);
    assert.equal(logs[0].args.amountCommitment, pkg.amountCommitment);
    assert.equal(logs[0].args.recipient?.toLowerCase(), s.alice.address.toLowerCase());
    spLog("S16 — UI: Show ClaimInstant in activity feed");
  });

  it("S17: full roster claims reduce campaign balance correctly", async () => {
    const s = await createSablierPayrollScenario();
    const { tree, campaign } = await s.freshCampaign({
      roster: [
        { recipient: s.alice.address, amount: 2_500n },
        { recipient: s.bob.address, amount: 3_000n },
        { recipient: s.carol.address, amount: 1_500n },
      ],
      fundAmount: 10_000n,
    });

    for (const who of ["alice", "bob", "carol"] as const) {
      await employee(s, who).claim(tree.packageFor(s[who].address), campaign);
    }
    await expectCampaignBalance(s, campaign.address, 10_000n - 2_500n - 3_000n - 1_500n);
    spLog("S17 — UI: Campaign remaining budget updated");
  });

  it("S18: admin clawback before any claim (no firstClaimTime)", async () => {
    const s = await createSablierPayrollScenario();
    const { campaign } = await s.freshCampaign({
      roster: [{ recipient: s.alice.address, amount: 1_000n }],
      fundAmount: 5_000n,
    });
    assert.equal(Number(await campaign.read.firstClaimTime()), 0);
    const before = (await s.token.read.balanceOf([s.employer.address])) as bigint;
    await admin(s).clawback(campaign, s.employer.address, 2_000n);
    const after = (await s.token.read.balanceOf([s.employer.address])) as bigint;
    assert.equal(after, before + 2_000n);
  });

  it("S19: non-admin cannot clawback", async () => {
    const s = await createSablierPayrollScenario();
    const { campaign } = await s.freshCampaign({
      roster: [{ recipient: s.alice.address, amount: 1_000n }],
    });
    await expectClaimReverts(() =>
      campaign.write.clawback([s.employer.address, 100n], { account: s.alice.address })
    );
  });

  it("S20: claim fee is forwarded to comptroller", async () => {
    const s = await createSablierPayrollScenario();
    const { tree, campaign } = await s.freshCampaign({
      roster: [{ recipient: s.alice.address, amount: 1_000n }],
      minFeeUSD: 5n,
    });
    const comptrollerBefore = (await s.publicClient.getBalance({
      address: s.comptroller.address,
    })) as bigint;
    const pkg = tree.packageFor(s.alice.address);
    await campaign.write.claim(
      [BigInt(pkg.index), pkg.recipient, pkg.amount, pkg.proof],
      { account: s.alice.address, value: 5n }
    );
    const comptrollerAfter = (await s.publicClient.getBalance({
      address: s.comptroller.address,
    })) as bigint;
    assert.equal(comptrollerAfter, comptrollerBefore + 5n);
  });

  it("S21: middle leaf in 3-employee tree claims with valid proof", async () => {
    const s = await createSablierPayrollScenario();
    const { tree, campaign } = await s.freshCampaign({
      roster: [
        { recipient: s.alice.address, amount: 1_000n },
        { recipient: s.bob.address, amount: 2_000n },
        { recipient: s.carol.address, amount: 3_000n },
      ],
      fundAmount: 10_000n,
    });
    const pkg = tree.packageAt(1);
    assert.ok(pkg.proof.length > 0);
    await employee(s, "bob").claim(pkg, campaign);
    assert.equal(await employee(s, "bob").readTokenBalance(), 2_000n);
  });
});
