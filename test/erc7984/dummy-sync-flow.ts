import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeEventTopics,
  encodePacked,
  getAddress,
  keccak256,
  parseAbiItem,
  parseEther,
  zeroAddress,
} from "viem";

const CONFIDENTIAL_TRANSFER = parseAbiItem(
  "event ConfidentialTransfer(address indexed from, address indexed to, bytes32 indexed amount)"
);
const REQUEST_STATUS = parseAbiItem(
  "event RequestStatusUpdated(bytes32 indexed requestId, uint8 status)"
);
const WRAP_REQUESTED = parseAbiItem(
  "event WrapRequested(address indexed from, address indexed to, uint256 amount, bytes32 indexed mintRequestId)"
);

const topicAddress = (topic: string) => getAddress(`0x${topic.slice(-40)}` as `0x${string}`);

describe("DummyTestPERC20 sync ERC-7984 flow", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;
  const bob = "0x00000000000000000000000000000000000000b0" as `0x${string}`;

  let underlying: any;
  let portal: any;
  let pToken: any;
  let inbox: any;

  before(async function () {
    underlying = await viem.deployContract("MockERC20Decimals", ["Dummy USD", "dUSD", 18], {
      client: { public: publicClient, wallet },
    });
    inbox = await viem.deployContract("PodCallbackTestInbox", [], {
      client: { public: publicClient, wallet },
    });
    portal = await viem.deployContract("PrivacyPortal", [], {
      client: { public: publicClient, wallet },
    });
    pToken = await viem.deployContract(
      "DummyTestPERC20",
      [portal.address, inbox.address, "Dummy Private USD", "dpUSD", 18],
      { client: { public: publicClient, wallet } }
    );
    await portal.write.initialize([underlying.address, pToken.address, 18, false, owner], {
      account: owner,
    });
  });

  it("supports ERC-7984 and emits ConfidentialTransfer on synchronous portal deposit", async function () {
    assert.equal(await pToken.read.supportsInterface(["0x4958f2a4"]), true);

    const depositAmount = parseEther("100");
    await underlying.write.mint([owner, depositAmount], { account: owner });
    await underlying.write.approve([portal.address, depositAmount], { account: owner });

    const depositHash = await portal.write.deposit([owner, depositAmount, 0n], {
      account: owner,
      value: 0n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });

    const ct = { ciphertextHigh: depositAmount, ciphertextLow: depositAmount };
    const expectedHandle = keccak256(encodePacked(["uint256", "uint256"], [depositAmount, depositAmount]));
    const topics = encodeEventTopics({
      abi: [CONFIDENTIAL_TRANSFER],
      eventName: "ConfidentialTransfer",
      args: { from: zeroAddress, to: owner, amount: expectedHandle },
    });
    const confidentialLog = receipt.logs.find(
      (entry) => entry.address.toLowerCase() === pToken.address.toLowerCase() && entry.topics[0] === topics[0]
    );
    assert.ok(confidentialLog, "ConfidentialTransfer missing on deposit mint");
    assert.equal(topicAddress(confidentialLog!.topics[1] as string), zeroAddress);
    assert.equal(topicAddress(confidentialLog!.topics[2] as string), getAddress(owner));
    assert.equal(confidentialLog!.topics[3], expectedHandle);

    assert.ok(
      receipt.logs.some(
        (entry) =>
          entry.address.toLowerCase() === portal.address.toLowerCase() &&
          entry.topics[0] === encodeEventTopics({ abi: [WRAP_REQUESTED], eventName: "WrapRequested" })[0]
      )
    );
    void ct;
  });

  it("emits ConfidentialTransfer on synchronous pToken transfer", async function () {
    const transferAmount = parseEther("25");
    const txHash = await pToken.write.transfer([bob, transferAmount, 0n], {
      account: owner,
      value: 0n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const expectedHandle = keccak256(encodePacked(["uint256", "uint256"], [transferAmount, transferAmount]));
    const topics = encodeEventTopics({
      abi: [CONFIDENTIAL_TRANSFER],
      eventName: "ConfidentialTransfer",
      args: { from: owner, to: bob, amount: expectedHandle },
    });
    const log = receipt.logs.find(
      (entry) => entry.address.toLowerCase() === pToken.address.toLowerCase() && entry.topics[0] === topics[0]
    );
    assert.ok(log, "ConfidentialTransfer missing on transfer");
    assert.equal(topicAddress(log!.topics[1] as string), getAddress(owner));
    assert.equal(topicAddress(log!.topics[2] as string), getAddress(bob));
  });

  it("emits ConfidentialTransfer when PodCallbackTestInbox completes a pending transfer", async function () {
    const amount = parseEther("10");
    const pendingHash = await pToken.write.transferPending([bob, amount], { account: owner });
    const pendingReceipt = await publicClient.waitForTransactionReceipt({ hash: pendingHash });
    const confidentialTopic = encodeEventTopics({
      abi: [CONFIDENTIAL_TRANSFER],
      eventName: "ConfidentialTransfer",
    })[0];
    assert.ok(
      pendingReceipt.logs.every((entry) => entry.topics[0] !== confidentialTopic),
      "pending transfer should not emit ConfidentialTransfer yet"
    );
    const statusTopic = encodeEventTopics({
      abi: [REQUEST_STATUS],
      eventName: "RequestStatusUpdated",
    })[0];
    const statusLogs = pendingReceipt.logs.filter((entry) => entry.topics[0] === statusTopic);
    assert.equal(statusLogs.length, 1);
    const requestId = statusLogs[0]!.topics[1];

    const completeHash = await inbox.write.completeTransfer(
      [pToken.address, requestId, owner, bob, amount],
      { account: owner }
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: completeHash });
    const expectedHandle = keccak256(encodePacked(["uint256", "uint256"], [amount, amount]));
    const topics = encodeEventTopics({
      abi: [CONFIDENTIAL_TRANSFER],
      eventName: "ConfidentialTransfer",
      args: { from: owner, to: bob, amount: expectedHandle },
    });
    assert.ok(
      receipt.logs.some(
        (entry) => entry.address.toLowerCase() === pToken.address.toLowerCase() && entry.topics[0] === topics[0]
      )
    );
  });
});
