/**
 * Story-facing ERC20 API over PodErc20Mintable (decrypt balances, encrypted transfers).
 * Privacy Portal is used only for corporate treasury top-ups (`mint`); payroll uses pToken only.
 */
import { decryptUint } from "@coti-io/coti-sdk-typescript";
import type { Address, Hex, PublicClient } from "viem";
import { toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decryptUint256,
  isSimCotiBackend,
  podTwoWayWriteOptions,
  receiptWaitOptions,
} from "../../../test/system/mpc-test-utils.js";
import { prepareSimIT256 } from "../../../simCOTI/sdk/index.js";
import {
  completePodOpRoundTrip,
  syncPodBalancesRoundTrip,
  type PodTokenTestContext,
} from "../../../test/tokens/test-token-utils.js";
import { createSimWallet } from "../../../test/sim-coti/sim-coti-utils.js";

export type StoryToken = {
  address: Address;
  read: {
    balanceOf: (args: [Address]) => Promise<bigint>;
    allowance: (args: [Address, Address]) => Promise<bigint>;
  };
  write: {
    transfer: (args: [Address, bigint], opts: { account: Address }) => Promise<Hex>;
    approve: (args: [Address, bigint], opts: { account: Address }) => Promise<Hex>;
    transferFrom: (args: [Address, Address, bigint], opts: { account: Address }) => Promise<Hex>;
    mint: (args: [Address, bigint], opts: { account: Address }) => Promise<Hex>;
  };
};

export type PayrollTokenAdapter = {
  token: StoryToken;
  syncAccount: (account: Address, label: string) => Promise<void>;
  userKeyFor: (account: Address) => string;
  buildTransferIt: (account: Address, amount: bigint) => Promise<{
    ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
    signature: Hex;
  }>;
};

const BATCH_PROCESS_SELECTOR = toFunctionSelector(
  "batchProcessRequests(uint256,(bytes32,address,address,(bytes4,bytes,bytes8[],bytes32[]),bytes4,bytes4,bool,bytes32,uint256,uint256)[])"
) as Hex;

function allowanceHalf(allowance: unknown, role: "owner" | "spender"): unknown {
  const tuple = allowance as Record<string, unknown>;
  const field = role === "owner" ? "ownerCiphertext" : "spenderCiphertext";
  return tuple[field] ?? tuple[role === "owner" ? 0 : 1];
}

function collectHardhatPrivateKeys(): Hex[] {
  const raw = [
    process.env.PRIVATE_KEY?.trim(),
    process.env.COTI_TESTNET_PRIVATE_KEY?.trim(),
    process.env._PRIVATE_KEY?.trim(),
    process.env.PRIVATE_KEY_ACCOUNT_2?.trim(),
    process.env.SEPOLIA_PRIVATE_KEY?.trim(),
  ].filter((k): k is string => !!k);
  const seen = new Set<string>();
  const out: Hex[] = [];
  for (const key of raw) {
    const normalized = (key.startsWith("0x") ? key : `0x${key}`).toLowerCase() as Hex;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function privateKeyForAddress(address: Address): Hex {
  const pk = collectHardhatPrivateKeys().find(
    (k) => privateKeyToAccount(k).address.toLowerCase() === address.toLowerCase()
  );
  if (!pk) {
    throw new Error(`no hardhat private key for ${address}`);
  }
  return pk;
}

export function createPayrollTokenAdapter(params: {
  portalCtx: PodTokenTestContext;
  publicClient: PublicClient;
  userKeys: Map<string, string>;
  defaultUserKey: string;
  topUpTreasury: (treasury: Address, amount: bigint, label: string) => Promise<void>;
  /** Route treasury transfers to payroll facades through fundCampaign (encrypted + pool credit). */
  isPayrollFacade?: (facade: Address) => boolean;
  fundCampaign?: (facade: Address, amount: bigint, account: Address) => Promise<Hex>;
}): PayrollTokenAdapter {
  const { portalCtx, publicClient, userKeys, defaultUserKey, topUpTreasury, isPayrollFacade, fundCampaign } =
    params;
  const { pod, base } = portalCtx;
  const fees = base.podTwoWayFees;

  function keyFor(account: Address): string {
    return userKeys.get(account.toLowerCase()) ?? defaultUserKey;
  }

  async function syncAccount(account: Address, label: string): Promise<void> {
    await syncPodBalancesRoundTrip(portalCtx, [account], label);
  }

  async function readBalance(account: Address): Promise<bigint> {
    await syncAccount(account, `balance-${account.slice(0, 10)}`);
    const ct = await pod.read.balanceOf([account]);
    const ciphertextHigh = BigInt((ct as { ciphertextHigh?: bigint }).ciphertextHigh ?? (ct as unknown[])[0] ?? 0);
    const ciphertextLow = BigInt((ct as { ciphertextLow?: bigint }).ciphertextLow ?? (ct as unknown[])[1] ?? 0);
    if (ciphertextHigh === 0n && ciphertextLow === 0n) return 0n;
    return decryptUint256({ ciphertextHigh, ciphertextLow }, keyFor(account), decryptUint);
  }

  async function buildItAmount(account: Address, amount: bigint) {
    if (!isSimCotiBackend()) {
      throw new Error("pod-payroll-port adapter supports sim COTI only");
    }
    const userKey = keyFor(account);
    const wallet = createSimWallet(privateKeyForAddress(account), userKey);
    const it = await prepareSimIT256(
      amount,
      { wallet, userKey },
      base.contracts.inboxCoti.address,
      BATCH_PROCESS_SELECTOR
    );
    const signature =
      typeof it.signature === "string" ? (it.signature as Hex) : (`0x${it.signature}` as Hex);
    return { ciphertext: it.ciphertext, signature };
  }

  async function transferToFacade(
    facade: Address,
    amount: bigint,
    account: Address
  ): Promise<Hex> {
    if (!fundCampaign) {
      throw new Error("fundCampaign hook required for payroll facade funding");
    }
    return fundCampaign(facade, amount, account);
  }

  function accountForWrite(address: Address): Address {
    return address;
  }

  const token: StoryToken = {
    address: pod.address as Address,
    read: {
      async balanceOf([account]) {
        return readBalance(account);
      },
      async allowance([owner, spender]) {
        const allowance = await pod.read.allowance([owner, spender]);
        const ownerCt = allowanceHalf(allowance, "owner");
        return decryptUint256(ownerCt, keyFor(owner), decryptUint);
      },
    },
    write: {
      async transfer([to, amount], { account }) {
        if (isPayrollFacade?.(to)) {
          return transferToFacade(to, amount, account);
        }
        const itAmount = await buildItAmount(account, amount);
        const hash = await pod.write.transfer(
          [to, itAmount, fees.callbackFeeWei],
          { account: accountForWrite(account), ...podTwoWayWriteOptions(fees) }
        );
        await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
        await completePodOpRoundTrip(portalCtx, `transfer-${account.slice(0, 8)}`, async () => hash);
        return hash;
      },
      async approve([spender, amount], { account }) {
        const itAmount = await buildItAmount(account, amount);
        const hash = await pod.write.approve(
          [spender, itAmount, fees.callbackFeeWei],
          { account: accountForWrite(account), ...podTwoWayWriteOptions(fees) }
        );
        await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
        await completePodOpRoundTrip(portalCtx, `approve-${account.slice(0, 8)}`, async () => hash);
        return hash;
      },
      async transferFrom([from, to, amount], { account }) {
        const itAmount = await buildItAmount(from, amount);
        const hash = await pod.write.transferFrom(
          [from, to, itAmount, fees.callbackFeeWei],
          { account: accountForWrite(account), ...podTwoWayWriteOptions(fees) }
        );
        await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
        await completePodOpRoundTrip(portalCtx, `transferFrom-${account.slice(0, 8)}`, async () => hash);
        return hash;
      },
      async mint([to, amount]) {
        await topUpTreasury(to, amount, `treasury-topup-${to.slice(0, 10)}`);
        return `0x${"00".repeat(32)}` as Hex;
      },
    },
  };

  return { token, syncAccount, userKeyFor: keyFor, buildTransferIt: buildItAmount };
}
