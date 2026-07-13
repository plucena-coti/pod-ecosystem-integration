import { toFunctionSelector, type Address, type Hex } from "viem";
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
};

const REGISTER_LEAF_SELECTOR = toFunctionSelector(
  "registerLeaf(uint256,uint256,address,bytes32,((uint256,uint256),bytes))"
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

export async function buildPodItAmount(
  backend: PodPayrollBackend,
  amount: bigint,
  purpose: "register" | "claim"
): Promise<ItAmount> {
  if (purpose === "register") {
    return buildEncryptedInput256(backend.podCtx, amount, {
      validatingContract: backend.cotiPayroll.address,
      functionSelector: REGISTER_LEAF_SELECTOR,
    });
  }
  return buildEncryptedInput256(backend.podCtx, amount);
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
    readonly tokenAdapter: PayrollTokenAdapter
  ) {}

  async buildItAmount(amount: bigint, purpose: "register" | "claim" = "claim") {
    return buildPodItAmount(this, amount, purpose);
  }

  async buildPayoutItAmount(sender: Address, amount: bigint) {
    return buildPayoutItAmount(this, sender, amount);
  }
}
