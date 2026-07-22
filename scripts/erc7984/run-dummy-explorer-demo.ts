/**
 * Deploy fresh DummyTestPERC20 + PrivacyPortal on Sepolia and run deposit + transfer.
 * Emits ERC-7984 ConfidentialTransfer in the same tx (no COTI round-trip).
 *
 *   npx hardhat run scripts/erc7984/run-dummy-explorer-demo.ts --network sepolia
 *
 * Optional env:
 *   ERC7984_DEPOSIT_AMOUNT=0.01
 *   ERC7984_TRANSFER_AMOUNT=0.005
 */

import { writeFileSync } from "node:fs";
import { network } from "hardhat";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizePrivateKey, receiptWaitOptions, resolveCotiTestnetPrivateKey } from "../../test/system/mpc-test-utils.js";

const log = (step: string, detail?: unknown) => {
  const body =
    detail === undefined
      ? ""
      : typeof detail === "string"
        ? detail
        : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  console.log(`[erc7984-dummy] ${step}${body ? `\n${body}` : ""}`);
};

const sepoliaTxUrl = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
const blockscoutTxUrl = (hash: string) => `https://eth-sepolia.blockscout.com/tx/${hash}`;
const blockscoutTokenUrl = (addr: string) => `https://eth-sepolia.blockscout.com/token/${addr}`;

async function main() {
  const depositAmount = parseEther(process.env.ERC7984_DEPOSIT_AMOUNT ?? "0.01");
  const transferAmount = parseEther(process.env.ERC7984_TRANSFER_AMOUNT ?? "0.005");
  const bob = "0x00000000000000000000000000000000000000b0" as `0x${string}`;

  const conn = await network.connect({ network: "sepolia" });
  const publicClient = await conn.viem.getPublicClient();
  const pk = normalizePrivateKey(await resolveCotiTestnetPrivateKey(process.env.COTI_TESTNET_RPC_URL!));
  const owner = privateKeyToAccount(pk as `0x${string}`).address;
  const wallet = await conn.viem.getWalletClient(owner);

  log("deploying dummy ERC-7984 stack", { owner });
  const underlying = await conn.viem.deployContract(
    "MockERC20Decimals",
    ["Dummy Explorer USD", "dXUSD", 18],
    { client: { public: publicClient, wallet } }
  );
  const inbox = await conn.viem.deployContract("PodCallbackTestInbox", [], {
    client: { public: publicClient, wallet },
  });
  const portal = await conn.viem.deployContract("PrivacyPortal", [], {
    client: { public: publicClient, wallet },
  });
  const pToken = await conn.viem.deployContract(
    "DummyTestPERC20",
    [portal.address, inbox.address, "Dummy Private XUSD", "dpXUSD", 18],
    { client: { public: publicClient, wallet } }
  );
  const initHash = await portal.write.initialize([underlying.address, pToken.address, 18, false, owner], {
    account: owner,
  });
  await publicClient.waitForTransactionReceipt({ hash: initHash, ...receiptWaitOptions });

  const addresses = {
    underlying: underlying.address,
    portal: portal.address,
    pToken: pToken.address,
    inbox: inbox.address,
    owner,
  };
  log("deployed", addresses);
  writeFileSync("erc7984-dummy-deploy.json", `${JSON.stringify(addresses, null, 2)}\n`);

  const mintHash = await underlying.write.mint([owner, depositAmount], { account: owner });
  await publicClient.waitForTransactionReceipt({ hash: mintHash, ...receiptWaitOptions });
  const approveHash = await underlying.write.approve([portal.address, depositAmount], { account: owner });
  await publicClient.waitForTransactionReceipt({ hash: approveHash, ...receiptWaitOptions });

  const depositHash = await portal.write.deposit([owner, depositAmount, 0n], {
    account: owner,
    value: 0n,
  });
  await publicClient.waitForTransactionReceipt({ hash: depositHash, ...receiptWaitOptions });

  const transferHash = await pToken.write.transfer([bob, transferAmount, 0n], {
    account: owner,
    value: 0n,
  });
  await publicClient.waitForTransactionReceipt({ hash: transferHash, ...receiptWaitOptions });

  const supports7984 = await pToken.read.supportsInterface(["0x4958f2a4"]);

  console.log("\n========== Dummy ERC-7984 Sepolia demo ==========");
  console.log(`Owner:     ${owner}`);
  console.log(`Portal:    ${portal.address}`);
  console.log(`pToken:    ${pToken.address}`);
  console.log(`Underlying:${underlying.address}`);
  console.log(`Inbox:     ${inbox.address}`);
  console.log(`Saved:     erc7984-dummy-deploy.json`);
  console.log(`ERC-7984 supportsInterface(0x4958f2a4): ${supports7984}`);
  console.log("\nSepolia transactions (look for ConfidentialTransfer on pToken):");
  console.log(`  Deposit:   ${depositHash}`);
  console.log(`    Etherscan:  ${sepoliaTxUrl(depositHash)}`);
  console.log(`    Blockscout: ${blockscoutTxUrl(depositHash)}`);
  console.log(`  Transfer:  ${transferHash}`);
  console.log(`    Etherscan:  ${sepoliaTxUrl(transferHash)}`);
  console.log(`    Blockscout: ${blockscoutTxUrl(transferHash)}`);
  console.log(`\nBlockscout token page (verify source for ERC-7984 typing):`);
  console.log(`  ${blockscoutTokenUrl(pToken.address)}`);
  console.log("================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
