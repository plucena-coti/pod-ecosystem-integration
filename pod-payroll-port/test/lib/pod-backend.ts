import { toFunctionSelector, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { bytesToHex } from "viem";
import {
  buildEncryptedInput256,
  type TestContext,
} from "../../../test/system/mpc-test-utils.js";
import { createSimWallet } from "../../../test/sim-coti/sim-coti-utils.js";
import { prepareSimIT256 } from "../../../simCOTI/sdk/index.js";
import type { PublicClient } from "viem";
import type { PayrollTokenAdapter } from "./pod-token-adapter.js";
import type { PayrollPortalContext } from "./portal-setup.js";

export type ItAmount = {
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
  signature: Hex;
};

export type PodPayrollBackend = {
  podCtx: TestContext;
  portalCtx: PayrollPortalContext;
  publicClient: PublicClient;
  cotiPayroll: { address: Address };
  payrollVault: { address: Address };
  claimStore: {
    address: Address;
    write: { submitPayload: (...args: unknown[]) => Promise<Hex> };
  };
  adminWallet: { account: { address: Address } };
  callbackFeeWei: bigint;
  pTokenTransferFeeWei: bigint;
  pTokenCallbackFeeWei: bigint;
  cotiPrivateKey: Hex;
  tokenAdapter: PayrollTokenAdapter;
  ensureFacadeTokenIdle?: (facade: Address, label: string) => Promise<void>;
  buildItAmount: (
    amount: bigint,
    purpose?: "register" | "claim",
    opts?: { validatingContract?: Address; functionSelector?: Hex }
  ) => Promise<ItAmount>;
  buildPayoutItAmount: (sender: Address, amount: bigint) => Promise<ItAmount>;
  buildVerifyItAmount: (claimant: Address, amount: bigint) => Promise<ItAmount>;
  buildClaimItAmount: (
    claimant: Address,
    facade: Address,
    amount: bigint,
    functionSelector: Hex
  ) => Promise<ItAmount>;
  buildAckPoolIt: (facade: Address, account: Address, amount: bigint) => Promise<ItAmount>;
};

const REGISTER_LEAF_SELECTOR = toFunctionSelector(
  "registerLeaf(uint256,uint256,address,bytes32,((uint256,uint256),bytes))"
) as Hex;

const ACK_POOL_CREDIT_SELECTOR = toFunctionSelector(
  "ackPoolCredit(((uint256,uint256),bytes))"
) as Hex;

const BATCH_PROCESS_SELECTOR = toFunctionSelector(
  "batchProcessRequests(uint256,(bytes32,address,address,(bytes4,bytes,bytes8[],bytes32[]),bytes4,bytes4,bool,bytes32,uint256,uint256)[])"
) as Hex;

function formatItAmount(it: {
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
  signature: string | Hex;
}): ItAmount {
  const signature =
    typeof it.signature === "string" ? (it.signature as Hex) : (`0x${it.signature}` as Hex);
  return { ciphertext: it.ciphertext, signature };
}

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

function privateKeyForAddress(address: Address): Hex {
  const raw = [
    process.env.PRIVATE_KEY?.trim(),
    process.env.COTI_TESTNET_PRIVATE_KEY?.trim(),
    process.env._PRIVATE_KEY?.trim(),
    process.env.PRIVATE_KEY_ACCOUNT_2?.trim(),
    process.env.SEPOLIA_PRIVATE_KEY?.trim(),
  ].filter((k): k is string => !!k);
  for (const key of raw) {
    const normalized = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
    if (privateKeyToAccount(normalized).address.toLowerCase() === address.toLowerCase()) {
      return normalized;
    }
  }
  for (let i = 0; i < 20; i++) {
    const account = mnemonicToAccount(HARDHAT_MNEMONIC, { addressIndex: i });
    const pk = bytesToHex(account.getHdKey().privateKey!) as Hex;
    if (account.address.toLowerCase() === address.toLowerCase()) {
      return pk;
    }
  }
  throw new Error(`no private key for ${address}`);
}

function simWalletFor(backend: PodPayrollBackend, account: Address) {
  const userKey = backend.tokenAdapter.userKeyFor(account);
  const pk = privateKeyForAddress(account);
  return { wallet: createSimWallet(pk, userKey), userKey };
}

export async function buildPodItAmount(
  backend: PodPayrollBackend,
  amount: bigint,
  purpose: "register" | "claim",
  opts?: { validatingContract?: Address; functionSelector?: Hex }
): Promise<ItAmount> {
  if (purpose === "register") {
    return buildEncryptedInput256(backend.podCtx, amount, {
      validatingContract: backend.cotiPayroll.address,
      functionSelector: REGISTER_LEAF_SELECTOR,
    });
  }
  return buildEncryptedInput256(backend.podCtx, amount, {
    validatingContract: opts?.validatingContract,
    functionSelector: opts?.functionSelector,
  });
}

/** Encrypted pToken transfer IT for a contract sender (facade) registered on simCOTI. */
export async function buildPayoutItAmount(
  backend: PodPayrollBackend,
  sender: Address,
  amount: bigint
): Promise<ItAmount> {
  const userKey = backend.tokenAdapter.userKeyFor(sender);
  const wallet = createSimWallet(backend.cotiPrivateKey, userKey);
  const it = await prepareSimIT256(
    amount,
    { wallet, userKey },
    backend.podCtx.contracts.inboxCoti.address,
    BATCH_PROCESS_SELECTOR
  );
  return formatItAmount(it);
}

/** Encrypted verify IT for COTI `verifyAndCredit` (inbox-validated). */
export async function buildVerifyItAmount(
  backend: PodPayrollBackend,
  claimant: Address,
  amount: bigint
): Promise<ItAmount> {
  const { wallet, userKey } = simWalletFor(backend, claimant);
  const it = await prepareSimIT256(
    amount,
    { wallet, userKey },
    backend.podCtx.contracts.inboxCoti.address,
    BATCH_PROCESS_SELECTOR
  );
  return formatItAmount(it);
}

/** Encrypted claim amount IT signed by the claimant for facade `claim` / `claimTo`. */
export async function buildClaimItAmount(
  backend: PodPayrollBackend,
  claimant: Address,
  facade: Address,
  amount: bigint,
  functionSelector: Hex
): Promise<ItAmount> {
  const { wallet, userKey } = simWalletFor(backend, claimant);
  const it = await prepareSimIT256(amount, { wallet, userKey }, facade, functionSelector);
  return formatItAmount(it);
}

/** Encrypted pool credit IT for employer `ackPoolCredit` after treasury transfer. */
export async function buildAckPoolIt(
  backend: PodPayrollBackend,
  facade: Address,
  account: Address,
  amount: bigint
): Promise<ItAmount> {
  const { wallet, userKey } = simWalletFor(backend, account);
  const it = await prepareSimIT256(
    amount,
    { wallet, userKey },
    facade,
    ACK_POOL_CREDIT_SELECTOR
  );
  return formatItAmount(it);
}

export class PodPayrollBackendImpl implements PodPayrollBackend {
  constructor(
    readonly podCtx: TestContext,
    readonly portalCtx: PayrollPortalContext,
    readonly publicClient: PublicClient,
    readonly cotiPayroll: { address: Address },
    readonly payrollVault: { address: Address },
    readonly claimStore: PodPayrollBackend["claimStore"],
    readonly adminWallet: { account: { address: Address } },
    readonly callbackFeeWei: bigint,
    readonly pTokenTransferFeeWei: bigint,
    readonly pTokenCallbackFeeWei: bigint,
    readonly cotiPrivateKey: Hex,
    readonly tokenAdapter: PayrollTokenAdapter,
    readonly ensureFacadeTokenIdle?: (facade: Address, label: string) => Promise<void>
  ) {}

  async buildItAmount(
    amount: bigint,
    purpose: "register" | "claim" = "claim",
    opts?: { validatingContract?: Address; functionSelector?: Hex }
  ) {
    return buildPodItAmount(this, amount, purpose, opts);
  }

  async buildPayoutItAmount(sender: Address, amount: bigint) {
    return buildPayoutItAmount(this, sender, amount);
  }

  async buildVerifyItAmount(claimant: Address, amount: bigint) {
    return buildVerifyItAmount(this, claimant, amount);
  }

  async buildClaimItAmount(
    claimant: Address,
    facade: Address,
    amount: bigint,
    functionSelector: Hex
  ) {
    return buildClaimItAmount(this, claimant, facade, amount, functionSelector);
  }

  async buildAckPoolIt(facade: Address, account: Address, amount: bigint) {
    return buildAckPoolIt(this, facade, account, amount);
  }
}
