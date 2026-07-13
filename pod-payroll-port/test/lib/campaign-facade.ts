import { encodeAbiParameters, toFunctionSelector, type Address, type Hex } from "viem";
import type { ClaimPackage } from "./merkle.js";
import { encodeLeaf } from "./merkle.js";
import { logStep, podTwoWayWriteOptions } from "../../../test/system/mpc-test-utils.js";
import type { PodPayrollBackend } from "./pod-backend.js";
import { mineAfterPayoutClaim, mineAfterPayoutTransfer } from "./async.js";

export type CampaignContract = {
  address: Address;
  read: Record<string, (...args: unknown[]) => Promise<unknown>>;
  write: Record<string, (...args: unknown[]) => Promise<Hex>>;
};

const CLAIM_SELECTOR = toFunctionSelector(
  "claim(uint256,address,((uint256,uint256),bytes),bytes32[])"
) as Hex;

const CLAIM_TO_SELECTOR = toFunctionSelector(
  "claimTo(uint256,address,((uint256,uint256),bytes),bytes32[])"
) as Hex;

function formatItForAbi(it: {
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
  signature: Hex;
}) {
  return [it.ciphertext, it.signature] as const;
}

export function wrapCampaignFacade(
  raw: CampaignContract,
  backend: PodPayrollBackend
): CampaignContract {
  const { podCtx, claimStore } = backend;

  async function buildClaimIt(claimant: Address, amount: bigint, selector: Hex) {
    return backend.buildClaimItAmount(claimant, raw.address, amount, selector);
  }

  async function preparePayload(pkg: ClaimPackage, claimant: Address): Promise<void> {
    await backend.ensureFacadeTokenIdle?.(raw.address, `preclaim-${pkg.index}`);
    await backend.tokenAdapter.syncAccount(raw.address, `preclaim-facade-${pkg.index}`);
    await backend.tokenAdapter.syncAccount(claimant, `preclaim-claimant-${pkg.index}`);
    const facadeBalance = await backend.tokenAdapter.token.read.balanceOf([raw.address]);
    if (facadeBalance < pkg.amount) {
      throw new Error("InsufficientPoolBalance");
    }
    const verifyIt = await backend.buildVerifyItAmount(claimant, pkg.amount);
    const itAmount = await buildClaimIt(claimant, pkg.amount, CLAIM_SELECTOR);
    const payoutItAmount = await backend.buildPayoutItAmount(raw.address, pkg.amount);
    const proofHandle = encodeAbiParameters(
      [
        { type: "bytes32[]" },
        { type: "uint256" },
      ],
      [pkg.proof, BigInt(pkg.index)]
    );
    await claimStore.write.submitPayload(
      [raw.address, BigInt(pkg.index), verifyIt, proofHandle, payoutItAmount],
      { account: claimant }
    );
  }

  async function claimWithMining(
    fn: () => Promise<Hex>,
    pkg: ClaimPackage,
    claimant: Address,
    payoutTo: Address,
    expectSuccess: boolean
  ): Promise<Hex> {
    if (expectSuccess) {
      await preparePayload(pkg, claimant);
    }
    let hash: Hex;
    try {
      hash = await fn();
    } catch (e) {
      throw e;
    }
    const receipt = await backend.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error("claim transaction reverted");
    }
    if (!expectSuccess) return hash;
    try {
      await mineAfterPayoutClaim(podCtx, `claim-${pkg.index}`);
      await mineAfterPayoutTransfer(podCtx, `payout-${pkg.index}`);
      if (backend.tokenAdapter) {
        await backend.tokenAdapter.syncAccount(payoutTo, `sync-${pkg.index}`);
      }
    } catch (e) {
      logStep(`pod-payroll-port: mine failed index=${pkg.index}: ${String(e)}`);
      throw new Error("claim failed");
    }
    const claimed = (await raw.read.hasClaimed([BigInt(pkg.index)])) as boolean;
    if (!claimed) {
      logStep(`pod-payroll-port: hasClaimed false after mine index=${pkg.index}`);
      throw new Error("claim failed");
    }
    return hash;
  }

  async function encryptedClaimArgs(
    index: bigint,
    recipient: Address,
    amount: bigint,
    proof: Hex[],
    claimant: Address
  ) {
    const itAmount = await buildClaimIt(claimant, amount, CLAIM_SELECTOR);
    return [index, recipient, formatItForAbi(itAmount), proof] as const;
  }

  return {
    address: raw.address,
    read: raw.read,
    write: {
      ...raw.write,
      async claim(args: unknown[], opts?: { account?: Address; value?: bigint }) {
        const [index, recipient, amount, proof] = args as [bigint, Address, bigint, Hex[]];
        const pkg: ClaimPackage = {
          index: Number(index),
          recipient,
          amount,
          proof,
          leaf: encodeLeaf(Number(index), recipient, amount),
        };
        const claimant = (opts?.account ?? recipient) as Address;
        const encArgs = await encryptedClaimArgs(index, recipient, amount, proof, claimant);
        return claimWithMining(
          () => raw.write.claim(encArgs, opts),
          pkg,
          claimant,
          claimant,
          true
        );
      },
      async claimPackage(args: unknown[], opts?: { account?: Address; value?: bigint }) {
        const [pkg] = args as [ClaimPackage];
        const claimant = (opts?.account ?? pkg.recipient) as Address;
        const encArgs = await encryptedClaimArgs(
          BigInt(pkg.index),
          pkg.recipient,
          pkg.amount,
          pkg.proof,
          claimant
        );
        return claimWithMining(
          () => raw.write.claim(encArgs, opts),
          pkg,
          claimant,
          claimant,
          true
        );
      },
      async claimTo(args: unknown[], opts?: { account?: Address; value?: bigint }) {
        const [index, to, amount, proof] = args as [bigint, Address, bigint, Hex[]];
        const claimant = opts?.account as Address;
        const pkg: ClaimPackage = {
          index: Number(index),
          recipient: claimant,
          amount,
          proof,
          leaf: encodeLeaf(Number(index), claimant, amount),
        };
        const itAmount = await buildClaimIt(claimant, amount, CLAIM_TO_SELECTOR);
        const encArgs = [index, to, formatItForAbi(itAmount), proof] as const;
        return claimWithMining(
          () => raw.write.claimTo(encArgs, opts),
          pkg,
          claimant,
          to,
          true
        );
      },
      async claimToPackage(args: unknown[], opts?: { account?: Address; value?: bigint }) {
        const [pkg, to] = args as [ClaimPackage, Address];
        const claimant = opts?.account ?? pkg.recipient;
        const itAmount = await buildClaimIt(claimant as Address, pkg.amount, CLAIM_TO_SELECTOR);
        const encArgs = [BigInt(pkg.index), to, formatItForAbi(itAmount), pkg.proof] as const;
        return claimWithMining(
          () => raw.write.claimTo(encArgs, { ...opts, account: claimant as Address }),
          pkg,
          claimant as Address,
          to,
          true
        );
      },
      async clawback(args: unknown[], opts?: { account?: Address }) {
        const [to, amount] = args as [Address, bigint];
        const itAmount = await backend.buildPayoutItAmount(raw.address, amount);
        const fees = backend.portalCtx.base.podTwoWayFees;
        const hash = await raw.write.clawback([to, formatItForAbi(itAmount)], {
          ...opts,
          ...podTwoWayWriteOptions(fees),
        });
        const receipt = await backend.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "success") {
          await mineAfterPayoutTransfer(podCtx, "clawback");
        }
        return hash;
      },
    },
  };
}

/** Patch viem.deployContract to route Sablier harness deploys to PoD facade. */
export function patchSablierDeploy(
  viem: { deployContract: (...args: unknown[]) => Promise<CampaignContract> },
  backend: PodPayrollBackend,
  deployWrappedFacade: (args: unknown[]) => Promise<CampaignContract>
): void {
  const original = viem.deployContract.bind(viem);
  viem.deployContract = async (name: string, args: unknown[], opts?: unknown) => {
    if (typeof name === "string" && name.includes("SablierMerkleInstantHarness")) {
      return deployWrappedFacade(args);
    }
    return original(name, args, opts);
  };
}
