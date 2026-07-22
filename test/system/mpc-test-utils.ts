import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPublicClient, decodeAbiParameters, defineChain, http, toFunctionSelector, toHex, zeroAddress, type Hex } from "viem";
import {
  deployTestnetPriceOracle,
  podConfigureKeepInbox,
  resolveDeployerAddress,
  waitMined,
} from "../../scripts/deploy-utils.js";
import { privateKeyToAccount } from "viem/accounts";
import { ONBOARD_CONTRACT_ADDRESS, Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { decryptUint, decryptUint256 as sdkDecryptUint256, prepareIT, prepareIT256 } from "@coti-io/coti-sdk-typescript";
import {
  deriveSimAesKey,
  isSimCotiBackend,
  prepareSimIT256,
  decryptSimUint256,
  SIM_COTI_CHAIN_ID,
  SimWallet,
} from "../../../sim-coti-node/sdk/index.js";
import { JsonRpcProvider } from "ethers";

/**
 * Native `msg.value` split for two-way Pod / inbox calls (from `inbox.calculateTwoWayFeeRequiredInLocalToken`).
 *
 * **Not comparable to `Request.targetFee` / `Request.callerFee` on-chain** — those are **gas unit** budgets, not wei
 * (`InboxFeeManager.validateAndPrepareTwoWayFees`):
 * - **`callerFee`** ≈ `callbackFeeWei / tx.gasprice` (uses the **tx** gas price, often ≫ `DEFAULT_GAS_PRICE`).
 * - **`targetFee`** = `(totalWei - callbackWei) * getLocalTokenPriceUSDX128 / getRemoteTokenPriceUSDX128 / gasPrice`.
 *   With local ≈ ETH and remote ≈ COTI, `local/remote` is huge, so the **remote** leg’s stipend is a **large** gas number
 *   even when the **local wei** slice `(total - callback)` is tiny — each remote gas unit is cheap in USD vs ETH.
 */
export type PodTwoWayFeeEstimate = {
  totalValueWei: bigint;
  callbackFeeWei: bigint;
};

export type TestContext = {
  sepolia: {
    publicClient: any;
    wallet: any;
  };
  coti: {
    publicClient: any;
    wallet: any;
  };
  contracts: {
    inboxSepolia: any;
    inboxCoti: any;
    mpcAdder: any;
    mpcAdderAsCoti: any;
    mpcExecutor: any;
  };
  crypto: {
    userKey: string;
    cotiEncryptWallet: CotiWallet;
  };
  chainIds: {
    sepolia: number;
    coti: bigint;
  };
  /** Two-way native fee wei from {@link estimateGas} on the Hardhat inbox (after oracle + min-fee configs). */
  podTwoWayFees: PodTwoWayFeeEstimate;
};

/** Minimum context for `encryptValue` against the COTI inbox (shared by TestContext and PodTestContext). */
export type MpcEncryptContext = {
  crypto: TestContext["crypto"];
  contracts: { inboxCoti: { address: `0x${string}` } };
};

export type RequestMethodCall = {
  selector: `0x${string}`;
  data: `0x${string}`;
  datatypes: `0x${string}`[];
  datalens: `0x${string}`[];
};

export type Request = {
  requestId: `0x${string}`;
  targetChainId: bigint;
  targetContract: `0x${string}`;
  methodCall: RequestMethodCall;
  callerContract: `0x${string}`;
  originalSender: `0x${string}`;
  timestamp: bigint;
  callbackSelector: `0x${string}`;
  errorSelector: `0x${string}`;
  isTwoWay: boolean;
  executed: boolean;
  sourceRequestId: `0x${string}`;
  targetFee: bigint;
  callerFee: bigint;
};

// Reads a tuple field by name or index.
export const getTupleField = (value: any, key: string, index: number) => value?.[key] ?? value?.[index];

// Reads a required environment variable.
export const requireEnv = (key: string) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing ${key} environment variable`);
  }
  return value;
};

// Reads a required private key (specific key or fallback).
export const requirePrivateKey = (key: string) => {
  const value = process.env[key] ?? process.env.PRIVATE_KEY;
  if (!value) {
    throw new Error(`Missing ${key} or PRIVATE_KEY environment variable`);
  }
  return value;
};

// Normalizes a private key to 0x-prefixed hex.
export const normalizePrivateKey = (key: string) => (key.startsWith("0x") ? key : `0x${key}`);

/** Minimum native balance to prefer a COTI test key (batch mines need ~0.4 COTI headroom each). */
const MIN_COTI_TEST_BALANCE_WEI = 50_000_000_000_000_000n; // 0.05 COTI

let cachedCotiPrivateKey: string | undefined;

/**
 * Picks a funded COTI testnet key. Order matches `hardhat.config.ts` plus `PRIVATE_KEY_ACCOUNT_2`.
 * When `COTI_TESTNET_PRIVATE_KEY` is set but depleted, falls back to `_PRIVATE_KEY` / others.
 */
export const resolveCotiTestnetPrivateKey = async (rpcUrl?: string): Promise<string> => {
  if (cachedCotiPrivateKey) return cachedCotiPrivateKey;

  // Dual-chain sim uses Hardhat-unlocked accounts on both networks. Never pick a live
  // COTI EOA here — `getWalletClient` on the AVAX surrogate would fail with Unknown account.
  const backend = (process.env.COTI_BACKEND ?? "").trim().toLowerCase();
  if (backend === "sim" || backend === "simcoti") {
    const hardhatPk =
      process.env.HARDHAT_PRIVATE_KEY?.trim() ||
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    logStep(`Using Hardhat #0 for sim COTI tests`);
    cachedCotiPrivateKey = hardhatPk;
    return hardhatPk;
  }

  const candidates: Array<[string, string]> = [];
  const addCandidate = (label: string, value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) candidates.push([label, trimmed]);
  };
  addCandidate("COTI_TESTNET_PRIVATE_KEY", process.env.COTI_TESTNET_PRIVATE_KEY);
  addCandidate("_PRIVATE_KEY", process.env._PRIVATE_KEY);
  addCandidate("PRIVATE_KEY_ACCOUNT_2", process.env.PRIVATE_KEY_ACCOUNT_2);
  addCandidate("PRIVATE_KEY", process.env.PRIVATE_KEY);

  if (candidates.length === 0) {
    throw new Error("Missing COTI testnet private key (COTI_TESTNET_PRIVATE_KEY, _PRIVATE_KEY, or PRIVATE_KEY)");
  }

  const url = rpcUrl ?? requireEnv("COTI_TESTNET_RPC_URL");
  const client = createPublicClient({ transport: http(url) });

  for (const [label, pk] of candidates) {
    const account = privateKeyToAccount(normalizePrivateKey(pk) as `0x${string}`);
    const balance = await client.getBalance({ address: account.address });
    if (balance >= MIN_COTI_TEST_BALANCE_WEI) {
      logStep(`Using ${label} for COTI tests (${account.address}, ${Number(balance) / 1e18} COTI)`);
      cachedCotiPrivateKey = pk;
      return pk;
    }
  }

  const [fallbackLabel, fallbackPk] = candidates[0];
  const account = privateKeyToAccount(normalizePrivateKey(fallbackPk) as `0x${string}`);
  const balance = await client.getBalance({ address: account.address });
  logStep(
    `Warning: all COTI keys below ${Number(MIN_COTI_TEST_BALANCE_WEI) / 1e18} COTI; using ${fallbackLabel} ` +
      `(${account.address}, ${Number(balance) / 1e18} COTI)`
  );
  cachedCotiPrivateKey = fallbackPk;
  return fallbackPk;
};

// Returns a trimmed environment variable or empty string.
export const envOrEmpty = (key: string) => process.env[key]?.trim() ?? "";

// Writes step logs with a common prefix.
export const logStep = (message: string) => {
  console.log(`[mpc-test] ${message}`);
};

/**
 * Deploy the (constructor-arg-free) {Inbox} and run its one-time {Inbox.init} initializer,
 * setting `chainId` and keeping ownership with the deploying account. Mirrors the production
 * CreateX `deployCreate3AndInit` flow, but deploys directly since CreateX is not present on the
 * in-process EDR test network.
 */
export const deployInboxWithInit = async (
  hh: {
    deployContract: (name: string, args: unknown[], opts?: any) => Promise<any>;
    getWalletClients: (opts?: any) => Promise<any[]>;
  },
  chainId: bigint,
  clientOpts?: any
): Promise<any> => {
  const inbox = await hh.deployContract("Inbox", [], clientOpts);
  const owner: `0x${string}` =
    clientOpts?.client?.wallet?.account?.address ??
    (await hh.getWalletClients())[0].account.address;
  await inbox.write.init([owner, chainId]);
  return inbox;
};

// Returns a receipt wait config with consistent polling.
export const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

/** Native ETH for contracts that pay fixed inbox fees ({PodLibBase.INBOX_TWO_WAY_FEE_WEI}, etc.). */
export const fundContractForInboxFees = async (
  walletClient: any,
  publicClient: any,
  contractAddress: `0x${string}`,
  wei: bigint = 10n ** 18n
) => {
  const hash = await walletClient.sendTransaction({
    to: contractAddress,
    value: wei,
  });
  await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
};

/**
 * Local leg min-fee template (aligned with `test/InboxFeeCalculation.ts` LOCAL_TEMPLATE).
 * Remote leg uses a constant minimum gas-units floor (aligned with `REMOTE_MIN_GAS_UNITS` there) so the remote branch
 * in `calculateTwoWayFeeRequired` matches validation (`expectedMinFee` with constant remote config).
 */
const MPC_SYSTEM_INBOX_LOCAL_MIN_FEE = {
  constantFee: 0n,
  gasPerByte: 10n,
  callbackExecutionGas: 100_000n,
  errorLength: 300n,
  bufferRatioX10000: 100n,
};
const MPC_SYSTEM_INBOX_REMOTE_MIN_FEE = {
  constantFee: 18_000_000n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
};

/**
 * {InboxMiner} uses `Request.targetFee` as the subcall gas budget (`target.call{gas: targetFee}(...)`).
 * Remote one-way responses (e.g. COTI → Hardhat callback) often carry `targetFee: 0`; mining that as-is
 * gives the callee zero gas, so callbacks like `receiveC` never succeed and ciphertext slots stay zero.
 * Use a budget large enough for worst-case Pod callbacks: `ctUint256` / `receiveC(bytes)` decodes much more
 * than `ctUint128` (~350k was enough for 128-bit; 256-bit OOG leaves stale `_result` and failing decrypt tests).
 * EIP-150 caps forwarded gas to `63/64 * gasleft()` before `call{gas: targetFee}` — the outer tx must stay well
 * above `targetFee` or the subcall silently OOGs while `batchProcessRequests` still succeeds and records `errors`.
 */
export const DEFAULT_MINED_TARGET_EXECUTION_GAS = 2_500_000n;

/** Same as `InboxFeeManager.DEFAULT_GAS_PRICE` — wei per gas passed to `calculateTwoWayFeeRequiredInLocalToken` in setup. */
const MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI = 2_000_000_000;
/** Calldata size terms for the two-way fee helper (reasonable MPC payload headroom vs. `test/InboxFeeCalculation.ts`). */
const MPC_FEE_CALC_CALL_SIZE = 512n;
/** Extra execution gas terms for `calculateTwoWayFeeRequired` — 0 so estimates match `validateAndPrepareTwoWayFees` minima (template already includes `callbackExecutionGas`). */
const MPC_FEE_CALC_REMOTE_EXEC_GAS = 300000n;
const MPC_FEE_CALC_CALLBACK_EXEC_GAS = 300000n;

const padPodFeeWei = (x: bigint) => x + x / 20n + 1n;

/**
 * Two-way **native wei** for `msg.value` / callback args (not `eth_estimateGas`). Wraps
 * `calculateTwoWayFeeRequiredInLocalToken` with the current oracle + min-fee configs.
 *
 * On-chain, the inbox stores **gas units** in `Request.targetFee` / `callerFee`; see {@link PodTwoWayFeeEstimate}.
 */
export async function estimateGas(inbox: any): Promise<PodTwoWayFeeEstimate> {
  const [targetWei, callerWei] = await inbox.read.calculateTwoWayFeeRequiredInLocalToken([
    MPC_FEE_CALC_CALL_SIZE,
    MPC_FEE_CALC_CALL_SIZE,
    MPC_FEE_CALC_REMOTE_EXEC_GAS,
    MPC_FEE_CALC_CALLBACK_EXEC_GAS,
    MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI,
  ]);
  return {
    callbackFeeWei: padPodFeeWei(callerWei),
    totalValueWei: padPodFeeWei(targetWei + callerWei),
  };
}

/**
 * Deploys a {@link PriceOracle} with ETH/COTI legs ({@link oracleLegsForChain}) when missing, wires it to `inbox`,
 * and applies min-fee configs above. Call {@link estimateGas} on the Hardhat inbox after setup for `podTwoWayFees`. No-op
 * if `inbox` owner ≠ `walletClient` account (e.g. reused deployment from another key).
 */
export async function ensureMpcInboxOracleAndFees(params: {
  label: string;
  viem: any;
  publicClient: any;
  walletClient: any;
  chainId: number;
  inbox: any;
}): Promise<void> {
  const { label, viem, publicClient, walletClient, chainId, inbox } = params;
  const deployer = await resolveDeployerAddress(walletClient);
  const owner = (await inbox.read.owner()) as `0x${string}`;
  if (owner.toLowerCase() !== deployer.toLowerCase()) {
    logStep(`${label}: skip oracle/fee setup (inbox owner ${owner} != wallet ${deployer})`);
    return;
  }

  const currentOracle = (await inbox.read.priceOracle()) as `0x${string}`;
  if (currentOracle === zeroAddress) {
    logStep(`${label}: deploying PriceOracle (chainId=${chainId})`);
    const oracle = await deployTestnetPriceOracle({ viem, publicClient, walletClient, chainId });
    const setOracleHash = await inbox.write.setPriceOracle([oracle.address], { account: deployer });
    await waitMined(publicClient, setOracleHash);
    const [localUsd, remoteUsd] = await oracle.read.getPricesUSD();
    logStep(`${label}: PriceOracle ${oracle.address} getPricesUSD local=${localUsd} remote=${remoteUsd}`);
  } else {
    logStep(`${label}: PriceOracle already set: ${currentOracle}`);
  }

  const feeHash = await inbox.write.updateMinFeeConfigs(
    [MPC_SYSTEM_INBOX_LOCAL_MIN_FEE, MPC_SYSTEM_INBOX_REMOTE_MIN_FEE],
    { account: deployer }
  );
  await waitMined(publicClient, feeHash);
  logStep(`${label}: updateMinFeeConfigs applied`);

  // Pin fee→gas conversion to the same assumed price used by {@link estimateGas} (POD-07).
  // Without this, Hardhat basefee / minGasPriceWei floors shrink gas-unit budgets and trip CallbackFeeTooLow.
  const boundsHash = await inbox.write.setGasPriceBounds(
    [0n, BigInt(MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI), BigInt(MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI)],
    { account: deployer }
  );
  await waitMined(publicClient, boundsHash);
  logStep(`${label}: setGasPriceBounds pinned to estimate assumed gas price`);
}

/** Extra gas on the `batchProcessRequests` tx so the inbox can forward `targetFee` to the subcall (EIP-150). */
const MIN_BATCH_TX_GAS_HEADROOM = 2_500_000n;

/**
 * Minimum gas limit for the outer `batchProcessRequests` tx so `InboxMiner` can forward the full
 * `targetFee` stipend to `targetContract.call{gas: targetFee}(...)`. EIP-150 caps the child frame to
 * `63/64 * gasleft()` at the CALL opcode; without `gasleft() >= ceil(targetFee * 64/63)` the subcall
 * OOGs while the batch tx still succeeds and records `errors` (misread as an MPC/precompile revert).
 */
function minBatchTxGasForInnerStipend(targetFee: bigint): bigint {
  if (targetFee === 0n) return 0n;
  return (targetFee * 64n + 62n) / 63n + MIN_BATCH_TX_GAS_HEADROOM;
}

/**
 * Largest `Request.targetFee` (inner stipend gas units) such that `minBatchTxGasForInnerStipend(T)` fits in
 * `blockGasLimit` (COTI testnet blocks are ~120M gas; larger fees make the outer mine tx impossible).
 */
function maxCotiTargetFeeForBlock(blockGasLimit: bigint): bigint {
  if (blockGasLimit <= MIN_BATCH_TX_GAS_HEADROOM) return 0n;
  return ((blockGasLimit - MIN_BATCH_TX_GAS_HEADROOM) * 63n - 62n) / 64n;
}

/** COTI RPC rejects txs whose total fee exceeds ~1 ETH; cap `maxFeePerGas` so `gas * maxFeePerGas` stays under budget. */
async function applyCotiBatchTxFeePerGasCap(
  publicClient: any,
  gas: bigint,
  maxTxFeeWei: bigint,
  writeOptions: {
    account: any;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  }
): Promise<void> {
  if (gas === 0n) return;
  const maxWeiPerGas = maxTxFeeWei / gas;
  if (maxWeiPerGas === 0n) {
    throw new Error(
      `[mpc-test] COTI mine: gas=${gas} needs a tx fee > COTI_MAX_TX_FEE_WEI (${maxTxFeeWei}); raise the env cap or lower mined targetFee`
    );
  }
  try {
    const fees = await publicClient.estimateFeesPerGas();
    const estMax = fees.maxFeePerGas ?? (await publicClient.getGasPrice());
    const estPriority = fees.maxPriorityFeePerGas ?? 1n;
    const maxFeePerGas = estMax < maxWeiPerGas ? estMax : maxWeiPerGas;
    const maxPriorityFeePerGas = estPriority < maxFeePerGas ? estPriority : maxFeePerGas;
    const block = await publicClient.getBlock({ blockTag: "latest" });
    const base = block.baseFeePerGas;
    if (base !== undefined && base !== null && maxFeePerGas < base) {
      throw new Error(
        `[mpc-test] COTI mine: maxFeePerGas would be capped to ${maxWeiPerGas} wei/gas (tx fee budget / gas) but base fee is ${base}. Raise COTI_MAX_TX_FEE_WEI or wait for a lower base fee.`
      );
    }
    writeOptions.maxFeePerGas = maxFeePerGas;
    writeOptions.maxPriorityFeePerGas = maxPriorityFeePerGas;
  } catch (e) {
    if (e instanceof Error && e.message.includes("COTI mine:")) throw e;
    const gp = await publicClient.getGasPrice();
    writeOptions.gasPrice = gp < maxWeiPerGas ? gp : maxWeiPerGas;
  }
}

/** Hardhat EDR caps a single transaction at 2^24 gas; higher limits are rejected before broadcast. */
export const HARDHAT_EDR_TX_GAS_CAP = 16_777_216n;

/** viem `writeContract` options attaching the two-way native payment from {@link estimateGas}. */
export function podTwoWayWriteOptions(fees: PodTwoWayFeeEstimate): { value: bigint; gas: bigint } {
  // Small pad absorbs Hardhat base-fee drift between setup-time estimate and later sends.
  // Explicit gas: Hardhat EDR eth_estimateGas can under-estimate PoD two-way sends after POD-07 fee bounds.
  return {
    value: fees.totalValueWei + fees.totalValueWei / 20n,
    gas: 8_000_000n,
  };
}

/** Minimum context for sweeping native fees from both inbox deployments. */
export type InboxFeeSweepContext = {
  sepolia: TestContext["sepolia"];
  coti: TestContext["coti"];
  contracts: { inboxSepolia: any; inboxCoti: any };
};

/**
 * Calls `collectFees(to)` on Hardhat and COTI inbox contracts (owner-only) so test runs do not strand ETH on the inbox.
 * Intended for `afterEach` in cross-chain integration tests. Skips when balance is zero; logs and continues on failure
 * (e.g. reused inbox with a different owner).
 */
export async function collectInboxFeesAfterTest(ctx: InboxFeeSweepContext): Promise<void> {
  const { inboxSepolia, inboxCoti } = ctx.contracts;
  const sweep = async (label: string, publicClient: any, wallet: any, inbox: any) => {
    const addr = inbox.address as `0x${string}`;
    const bal = await publicClient.getBalance({ address: addr });
    if (bal === 0n) return;
    try {
      const hash = await inbox.write.collectFees([wallet.account.address], { account: wallet.account });
      await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
    } catch (e) {
      logStep(`collectInboxFeesAfterTest(${label}): ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await sweep("Sepolia", ctx.sepolia.publicClient, ctx.sepolia.wallet, inboxSepolia);
  await sweep("COTI", ctx.coti.publicClient, ctx.coti.wallet, inboxCoti);
}

// Onboards a user on COTI and returns the AES key.
const aesKeyCache = new Map<string, string>();
const aesKeyPromiseCache = new Map<string, Promise<string>>();

const normalizePrivateKeyId = (value: string) => value.replace(/^0x/, "").toLowerCase();

export const onboardUser = async (privateKey: string, rpcUrl: string, onboardAddress: string, keyEnv: string = 'COTI_AES_KEY') => {
  const privateKeyId = normalizePrivateKeyId(privateKey);
  const cacheId = `${privateKeyId}:${onboardAddress.toLowerCase()}:${rpcUrl}`;

  const cached = aesKeyCache.get(cacheId);
  if (cached) {
    return cached;
  }

  // simCoti: deterministic AES — never call live AccountOnboard / coti-ethers recover.
  if (isSimCotiBackend()) {
    const pk = normalizePrivateKey(privateKey) as Hex;
    const key = deriveSimAesKey(pk, SIM_COTI_CHAIN_ID);
    aesKeyCache.set(cacheId, key);
    process.env.COTI_AES_KEY = key;
    process.env.COTI_AES_KEY_FOR_PRIVATE_KEY = privateKeyId;
    process.env[`${keyEnv}_FOR_PRIVATE_KEY`] = privateKeyId;
    return key;
  }

  const envKey = process.env[keyEnv];
  const envKeyOwner =
    process.env[`${keyEnv}_FOR_PRIVATE_KEY`] ??
    (keyEnv === "COTI_AES_KEY" ? process.env.COTI_AES_KEY_FOR_PRIVATE_KEY : undefined);
  if (
    envKey &&
    envKeyOwner &&
    normalizePrivateKeyId(envKeyOwner) === privateKeyId
  ) {
    const normalizedEnvKey = envKey.replace(/^0x/, "");
    aesKeyCache.set(cacheId, normalizedEnvKey);
    return normalizedEnvKey;
  }

  const inflight = aesKeyPromiseCache.get(cacheId);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    logStep("Onboarding user via coti-ethers");
    const provider = new JsonRpcProvider(rpcUrl) as any;
    const wallet = new CotiWallet(privateKey, provider);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await wallet.generateOrRecoverAes(onboardAddress);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          logStep(`Onboarding attempt ${attempt + 1} failed, retrying...`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }
    if (lastErr) {
      throw lastErr;
    }
    let key = wallet.getUserOnboardInfo()?.aesKey;
    if (!key) {
      throw new Error("Failed to onboard user: missing AES key");
    }
    if (key.startsWith("0x")) {
      key = key.slice(2);
    }
    if (key.length > 32) {
      logStep(`Onboarded AES key length ${key.length}, trimming to 32 hex chars`);
      key = key.slice(0, 32);
    }
    logStep("Onboarding complete");
    aesKeyCache.set(cacheId, key);
    process.env.COTI_AES_KEY = key;
    process.env.COTI_AES_KEY_FOR_PRIVATE_KEY = privateKeyId;
    process.env[`${keyEnv}_FOR_PRIVATE_KEY`] = privateKeyId;
    aesKeyPromiseCache.delete(cacheId);
    return key;
  })();

  aesKeyPromiseCache.set(cacheId, promise);
  return promise;
};

// Parses a raw request tuple into a typed request object.
export const parseRequest = (raw: any): Request => {
  const methodCall = getTupleField(raw, "methodCall", 3);
  const parsedMethodCall: RequestMethodCall = {
    selector: getTupleField(methodCall, "selector", 0),
    data: getTupleField(methodCall, "data", 1),
    datatypes: getTupleField(methodCall, "datatypes", 2) ?? [],
    datalens: getTupleField(methodCall, "datalens", 3) ?? [],
  };

  return {
    requestId: getTupleField(raw, "requestId", 0),
    targetChainId: getTupleField(raw, "targetChainId", 1),
    targetContract: getTupleField(raw, "targetContract", 2),
    methodCall: parsedMethodCall,
    callerContract: getTupleField(raw, "callerContract", 4),
    originalSender: getTupleField(raw, "originalSender", 5),
    timestamp: getTupleField(raw, "timestamp", 6),
    callbackSelector: getTupleField(raw, "callbackSelector", 7),
    errorSelector: getTupleField(raw, "errorSelector", 8),
    isTwoWay: getTupleField(raw, "isTwoWay", 9),
    executed: getTupleField(raw, "executed", 10),
    sourceRequestId: getTupleField(raw, "sourceRequestId", 11),
    targetFee: (getTupleField(raw, "targetFee", 12) as bigint | undefined) ?? 0n,
    callerFee: (getTupleField(raw, "callerFee", 13) as bigint | undefined) ?? 0n,
  };
};

// Loads the latest request sent to `targetChainId` from the inbox using getRequests.
export const getLatestRequest = async (
  inbox: any,
  targetChainId: bigint | number
): Promise<Request> => {
  const requestCount = await inbox.read.getRequestsLen([BigInt(targetChainId)]);
  console.log("number of requests in source", requestCount);
  assert.ok(Number(requestCount) > 0);
  const fromIndex = Number(requestCount) - 1;
  const requests = await getRequests(inbox, targetChainId, fromIndex, 1);
  assert.ok(requests.length > 0);
  return requests[0];
};

// Loads a single outbound request from the inbox mapping (id encodes source+target+nonce).
export const getRequest = async (inbox: any, requestId: `0x${string}`): Promise<Request> => {
  const raw = await inbox.read.requests([requestId]);
  return parseRequest(raw);
};

// Loads a range of requests sent to `targetChainId` and parses them.
export const getRequests = async (
  inbox: any,
  targetChainId: bigint | number,
  from: number,
  len: number
): Promise<Request[]> => {
  const raw = await inbox.read.getRequests([BigInt(targetChainId), from, len]);
  return (raw as any[]).map(parseRequest);
};

const envBigIntOr = (key: string, fallback: bigint): bigint => {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  try {
    return BigInt(raw);
  } catch {
    return fallback;
  }
};

/** Result of mineRequest; use requestIdUsed for getResponseRequestBySource / getInboxResponse. */
export type MineRequestResult = {
  txHash: `0x${string}`;
  requestIdUsed: `0x${string}`;
};

/** Context shape required by mineRequest (64-bit, wide MPC, etc.). */
export type MineRequestContext = {
  contracts: { inboxCoti: any; inboxSepolia: any };
  coti: { wallet: any; publicClient: any };
  sepolia: { wallet: any; publicClient: any };
};

/** Options for mineRequest / {@link runPodRoundTrip}. */
export type MineRequestOptions = {
  /** Force a specific nonce instead of computing next from lastIncomingRequestId. */
  nonceOverride?: number;
  /** Gas limit for the batchProcessRequests tx (e.g. for 256-bit MPC on COTI testnet). */
  gas?: bigint;
  /**
   * Gas limit for the Hardhat `PodTest*.exec*` tx (outbound POD leg). Large `itUint256` payloads and
   * `sendTwoWayMessage` can require far more than default `eth_estimateGas`; some nodes error with
   * `gas required exceeds allowance (264187)` when the implicit cap is too low.
   */
  hardhatGas?: bigint;
};

// Mines a source request on the target inbox and waits for confirmation.
// Uses `request.requestId` from the source inbox (e.g. Hardhat outbox) so the mined batch matches the
// actual outbound message. Deriving the id only from the target inbox `lastIncomingRequestId` can desync
// after other tests, replays, or partial round-trips. Pass `nonceOverride` only when you must synthesize an id.
export const mineRequest = async (
  ctx: MineRequestContext,
  chain: "coti" | "sepolia",
  sourceChainId: bigint,
  request: Request,
  label: string,
  options?: MineRequestOptions
): Promise<MineRequestResult> => {
  console.log("mineRequest", chain, sourceChainId, request, label);
  const inbox = chain === "coti" ? ctx.contracts.inboxCoti : ctx.contracts.inboxSepolia;
  const walletClient = chain === "coti" ? ctx.coti.wallet : ctx.sepolia.wallet;
  const chainLabel = chain.toUpperCase();
  logStep(`${label}: using ${chainLabel} inbox ${inbox.address}`);
  logStep(`${label}: ${chainLabel} inbox wallet ${walletClient?.account?.address ?? "unknown"}`);
  const publicClient = chain === "coti" ? ctx.coti.publicClient : ctx.sepolia.publicClient;
  console.log("reading last incoming request id", sourceChainId);
  const latestMinedRequestId = await inbox.read.lastIncomingRequestId([sourceChainId]);
  logStep(`${label}: latest mined request on ${chainLabel} is ${latestMinedRequestId.toString()}`);

  let nextRequestId: `0x${string}`;
  if (options?.nonceOverride !== undefined) {
    const targetChainIdForId = (await inbox.read.chainId()) as bigint;
    nextRequestId = (await inbox.read.getRequestId([
      sourceChainId,
      targetChainIdForId,
      BigInt(options.nonceOverride),
    ])) as `0x${string}`;
    logStep(`${label}: nonceOverride ${options.nonceOverride} → requestId ${nextRequestId}`);
  } else {
    nextRequestId = request.requestId;
    logStep(`${label}: using request.requestId ${nextRequestId} for batchProcessRequests`);
  }

  logStep(`${label}: calling batchProcessRequests on ${chainLabel}`);
  let targetFeeForMine =
    request.targetFee > 0n ? request.targetFee : DEFAULT_MINED_TARGET_EXECUTION_GAS;
  const writeOptions: {
    account: any;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  } = {
    account: walletClient?.account,
  };
  // When targetFee=0 (typical COTI→Hardhat callback): substitute a subcall stipend; outer tx must
  // forward it (EIP-150). When targetFee>0: `targetFee` is gas units for the inner call — outer tx
  // gas must still exceed `ceil(targetFee*64/63)+headroom` or the subcall OOGs while the batch succeeds.
  if (request.targetFee === 0n) {
    const minBatchTxGas = targetFeeForMine + MIN_BATCH_TX_GAS_HEADROOM;
    writeOptions.gas =
      options?.gas !== undefined && options.gas > minBatchTxGas ? options.gas : minBatchTxGas;
  } else {
    if (chain === "coti") {
      const blockGasLimit = envBigIntOr("COTI_BLOCK_GAS_LIMIT", 120_000_000n);
      const maxT = maxCotiTargetFeeForBlock(blockGasLimit);
      if (targetFeeForMine > maxT) {
        logStep(
          `${label}: capping targetFee ${targetFeeForMine} → ${maxT} (COTI block gas ${blockGasLimit}, EIP-150 outer tx)`
        );
        targetFeeForMine = maxT;
      }
    }
    const minBatchTxGas = minBatchTxGasForInnerStipend(targetFeeForMine);
    let gas = options?.gas !== undefined && options.gas > minBatchTxGas ? options.gas : minBatchTxGas;
    // Pod tests use Hardhat EDR as "Sepolia"; EDR rejects tx gas > 16M. The return-leg callback is cheap;
    // `targetFee` on the response request can still mirror COTI fee-budget units — cap the outer tx here.
    // simCoti is also EDR (chain 7082401), so apply the same cap on the COTI mine leg.
    const edrCoti = chain === "coti" && isSimCotiBackend();
    if ((chain === "sepolia" || edrCoti) && gas > HARDHAT_EDR_TX_GAS_CAP) {
      gas = HARDHAT_EDR_TX_GAS_CAP;
    }
    if (chain === "coti" && !edrCoti) {
      const blockGasLimit = envBigIntOr("COTI_BLOCK_GAS_LIMIT", 120_000_000n);
      if (gas > blockGasLimit) {
        gas = blockGasLimit;
      }
    }
    writeOptions.gas = gas;
    if (chain === "coti") {
      const maxTxFeeWei = envBigIntOr("COTI_MAX_TX_FEE_WEI", 1_000_000_000_000_000_000n);
      await applyCotiBatchTxFeePerGasCap(publicClient, gas, maxTxFeeWei, writeOptions);
    }
  }
  const txHash = (await inbox.write.batchProcessRequests(
    [
      sourceChainId,
      [
        {
          requestId: nextRequestId,
          sourceContract: request.originalSender,
          targetContract: request.targetContract,
          methodCall: request.methodCall,
          callbackSelector: request.callbackSelector ?? "0x00000000",
          errorSelector: request.errorSelector ?? "0x00000000",
          isTwoWay: request.isTwoWay,
          sourceRequestId: request.sourceRequestId,
          targetFee: targetFeeForMine,
          callerFee: request.callerFee,
        },
      ],
    ],
    writeOptions
  )) as `0x${string}`;
  logStep(`${label}: waiting for ${chainLabel} tx ${txHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    ...receiptWaitOptions,
  });
  if (receipt.status !== "success") {
    throw new Error(
      `${label}: ${chainLabel} batchProcessRequests tx reverted (status=${receipt.status}): ${txHash}`
    );
  }
  // Return-leg mines on Hardhat often use substituted `targetFee`; if the subcall OOGs/reverts, `_result` stays stale.
  if (chain === "sepolia") {
    const rawErr = await inbox.read.errors([nextRequestId]);
    const errRequestId = getTupleField(rawErr, "requestId", 0) as `0x${string}` | undefined;
    const errorCode = getTupleField(rawErr, "errorCode", 1) as bigint | number | undefined;
    if (
      errRequestId &&
      errRequestId !== "0x0000000000000000000000000000000000000000000000000000000000000000" &&
      errorCode !== undefined &&
      BigInt(errorCode) === 1n
    ) {
      const errorMessage = getTupleField(rawErr, "errorMessage", 2);
      throw new Error(
        `${label}: callback subcall failed on ${chainLabel} (requestId=${nextRequestId}) errorCode=${errorCode} ` +
          `errorMessage=${String(errorMessage)}`
      );
    }
  }
  return { txHash, requestIdUsed: nextRequestId };
};

/** Hardhat + COTI inboxes and chain IDs (e.g. {@link TestContext}). */
export type CrossChainTwoWayContext = MineRequestContext & {
  chainIds: { sepolia: number; coti: bigint };
};

/**
 * Finishes a two-way cross-chain round-trip after Hardhat has already recorded the outbound `sendTwoWayMessage`:
 * 1) `mineRequest` on COTI — runs the remote target (`respond`, `raise`, MPC, …)
 * 2) `getResponseRequestBySource` — load the return one-way request
 * 3) `mineRequest` on Hardhat — delivers success or error callback
 *
 * Same return-leg pattern as {@link runPodRoundTrip}: only `nonceOverride` is forwarded to the Hardhat mine
 * (large `gas` is for the COTI `batchProcessRequests` only).
 */
export const runCrossChainTwoWayRoundTrip = async (
  ctx: CrossChainTwoWayContext,
  label: string,
  mineOptions?: MineRequestOptions
): Promise<{
  outboundRequest: Request;
  cotiIncomingRequestId: `0x${string}`;
  returnLegRequest: Request;
  /** Receipt target on Hardhat for the return leg (callback / error delivery). */
  sepoliaRelayTxHash: `0x${string}`;
}> => {
  const outboundRequest = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);
  const { requestIdUsed: cotiIncomingRequestId } = await mineRequest(
    ctx,
    "coti",
    BigInt(ctx.chainIds.sepolia),
    outboundRequest,
    label,
    mineOptions
  );
  const returnLegRequest = await getResponseRequestBySource(
    ctx.contracts.inboxCoti,
    cotiIncomingRequestId,
    label
  );
  const sepoliaMineOpts: MineRequestOptions | undefined =
    mineOptions?.nonceOverride !== undefined ? { nonceOverride: mineOptions.nonceOverride } : undefined;
  const { txHash: sepoliaRelayTxHash } = await mineRequest(
    ctx,
    "sepolia",
    ctx.chainIds.coti,
    returnLegRequest,
    label,
    sepoliaMineOpts
  );
  return { outboundRequest, cotiIncomingRequestId, returnLegRequest, sepoliaRelayTxHash };
};

/**
 * Default gas for mining 128-bit MPC requests on COTI (`batchProcessRequests`).
 * `randBoundedBits128` and similar paths need more than 8M on many testnets; override with `COTI_MINE_GAS_MPC_128`.
 */
export const DEFAULT_COTI_MINE_GAS_MPC_128 = envBigIntOr("COTI_MINE_GAS_MPC_128", 30_000_000n);

/**
 * Default gas for mining 256-bit MPC on COTI (`batchProcessRequests` → `MpcExecutor.mul256` etc.).
 * Secret `MpcCore.mul(gtUint256)` is very heavy; 12M often yields inbox errorCode=1 / empty errorMessage (OOG).
 * Override: `COTI_MINE_GAS_MPC_256=60000000`.
 */
export const DEFAULT_COTI_MINE_GAS_MPC_256 = envBigIntOr("COTI_MINE_GAS_MPC_256", 50_000_000n);

/**
 * Returns a mineRequest wrapper that applies a default gas limit when mining on COTI
 * (callers can still override via options.gas).
 */
export function createMineRequestWithDefaultCotiGas(defaultGas: bigint) {
  return async (
    ctx: MineRequestContext,
    chain: "coti" | "sepolia",
    sourceChainId: bigint,
    request: Request,
    label: string,
    options?: MineRequestOptions
  ): Promise<MineRequestResult> => {
    const merged: MineRequestOptions =
      chain === "coti" ? { ...options, gas: options?.gas ?? defaultGas } : options ?? {};
    return mineRequest(ctx, chain, sourceChainId, request, label, merged);
  };
}

// Loads the response request linked to a source request id.
export const getResponseRequestBySource = async (
  inboxCoti: any,
  sourceRequestId: `0x${string}`,
  label: string
): Promise<Request> => {
  const rawResponse = await inboxCoti.read.inboxResponses([sourceRequestId]);
  const responseRequestId = getTupleField(rawResponse, "responseRequestId", 0) as `0x${string}`;
  const hasResponse =
    responseRequestId &&
    responseRequestId !== "0x0000000000000000000000000000000000000000000000000000000000000000";
  if (!hasResponse) {
    const err = await inboxCoti.read.errors([sourceRequestId]);
    const errId = getTupleField(err, "requestId", 0);
    if (errId && errId !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
      const errorCode = getTupleField(err, "errorCode", 1);
      const errorMessage = getTupleField(err, "errorMessage", 2);
      const rawHex =
        typeof errorMessage === "string" && errorMessage.startsWith("0x") ? errorMessage : String(errorMessage ?? "");
      const selector =
        rawHex.length >= 10 ? (rawHex.slice(0, 10) as `0x${string}`) : "(none)";
      throw new Error(
        `COTI execution failed for ${label}: errorCode=${errorCode} errorMessage=${errorMessage ?? "unknown"}. ` +
          `Revert selector (first 4 bytes): ${selector}. ` +
          `Typical causes: inner target reverted (e.g. PodErc20CotiSide MPC ` +
            `offBoardToUser for approve/transfer amounts if parties are not onboarded, or OOG — try COTI_MINE_GAS_POD_TOKEN / COTI_MINE_GAS_MPC_256).`
      );
    }
    throw new Error(`Missing COTI response for ${label}: responseRequestId not set`);
  }
  logStep(`${label}: responseRequestId=${responseRequestId}`);

  const rawRequest = await inboxCoti.read.requests([responseRequestId]);
  const responseRequest = parseRequest(rawRequest);
  assert.ok(responseRequest);
  return responseRequest;
};

// Encrypts an input value using the COTI wallet.
export const buildEncryptedInput = async (
  ctx: MpcEncryptContext,
  value: bigint
): Promise<{ ciphertext: bigint; signature: `0x${string}` }> => {
  const functionSelector = toFunctionSelector(
      "batchProcessRequests(uint256,(bytes32,address,address,(bytes4,bytes,bytes8[],bytes32[]),bytes4,bytes4,bool,bytes32,uint256,uint256)[])"
  );
  const inputText = await ctx.crypto.cotiEncryptWallet.encryptValue(
    value,
    ctx.contracts.inboxCoti.address,
    functionSelector
  );
  const signature =
    typeof inputText.signature === "string"
      ? (inputText.signature as `0x${string}`)
      : toHex(inputText.signature as any);
  const ciphertext = normalizeCiphertextInternal(inputText.ciphertext);
  return {
    ciphertext,
    signature,
  };
};

// Decodes a ctUint64-like value into a bigint ciphertext.
export const decodeCtUint64 = (encryptedResult: unknown): bigint => {
  return (
    getTupleField(encryptedResult, "ciphertext", 0) ??
    getTupleField(encryptedResult, "value", 0) ??
    (encryptedResult as bigint)
  );
};

/**
 * Split a 128-bit value into two 64-bit parts (high, low).
 */
export const split128To64Parts = (value: bigint): [bigint, bigint] => {
  const mask64 = (1n << 64n) - 1n;
  const low = value & mask64;
  const high = (value >> 64n) & mask64;
  return [high, low];
};

/**
 * Combine two 64-bit parts into a 128-bit value.
 */
export const combine64PartsTo128 = (high: bigint, low: bigint): bigint => {
  return (high << 64n) | low;
};

/**
 * Split a 256-bit value into four 64-bit parts (high.high, high.low, low.high, low.low).
 */
export const split256To64Parts = (value: bigint): [bigint, bigint, bigint, bigint] => {
  const mask64 = (1n << 64n) - 1n;
  const lowLow = value & mask64;
  const lowHigh = (value >> 64n) & mask64;
  const highLow = (value >> 128n) & mask64;
  const highHigh = (value >> 192n) & mask64;
  return [highHigh, highLow, lowHigh, lowLow];
};

/**
 * Combine four 64-bit parts into a 256-bit value.
 */
export const combine64PartsTo256 = (
  highHigh: bigint,
  highLow: bigint,
  lowHigh: bigint,
  lowLow: bigint
): bigint => {
  return (highHigh << 192n) | (highLow << 128n) | (lowHigh << 64n) | lowLow;
};

// Encrypt a 128-bit value as an itUint128 structure (single ciphertext + signature).
export const buildEncryptedInput128 = async (
  ctx: MpcEncryptContext,
  value: bigint
): Promise<{
  ciphertext: bigint;
  signature: `0x${string}`;
}> => {
  const functionSelector = toFunctionSelector(
    "batchProcessRequests(uint256,(bytes32,address,address,(bytes4,bytes,bytes8[],bytes32[]),bytes4,bytes4,bool,bytes32,uint256,uint256)[])"
  );

  const it = prepareIT(value, {
    wallet: ctx.crypto.cotiEncryptWallet as any,
    userKey: ctx.crypto.userKey,
  }, ctx.contracts.inboxCoti.address, functionSelector);

  const signature =
    typeof it.signature === "string"
      ? (it.signature as `0x${string}`)
      : toHex(it.signature as any);

  return {
    ciphertext: it.ciphertext,
    signature,
  };
};

// Decode a ctUint128 value (single uint256 ciphertext).
export const decodeCtUint128 = (encryptedResult: unknown): bigint => {
  return BigInt(
    getTupleField(encryptedResult, "ciphertext", 0) ??
      getTupleField(encryptedResult, "value", 0) ??
      encryptedResult ??
      0
  );
};

// Decrypt a ctUint128 result into a 128-bit value.
export const decryptUint128 = (
  encryptedResult: unknown,
  userKey: string,
  decryptFn: (ct: bigint, key: string) => bigint = decryptUint
): bigint => {
  const ct = decodeCtUint128(encryptedResult);
  return decryptFn(ct, userKey);
};

// Encrypt a 256-bit value as an itUint256 structure (inbox-validated; signer must be miner / tx.origin).
export const buildEncryptedInput256 = async (
  ctx: MpcEncryptContext,
  value: bigint
): Promise<{
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
  signature: `0x${string}`;
}> => {
  const functionSelector = toFunctionSelector(
    "batchProcessRequests(uint256,(bytes32,address,address,(bytes4,bytes,bytes8[],bytes32[]),bytes4,bytes4,bool,bytes32,uint256,uint256)[])"
  );

  let it: { ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint }; signature: string | `0x${string}` };
  if (isSimCotiBackend()) {
    const wallet = ctx.crypto.cotiEncryptWallet as SimWallet;
    it = await prepareSimIT256(
      value,
      { wallet, userKey: ctx.crypto.userKey },
      ctx.contracts.inboxCoti.address,
      functionSelector
    );
  } else {
    it = prepareIT256(
      value,
      {
        wallet: ctx.crypto.cotiEncryptWallet as any,
        userKey: ctx.crypto.userKey,
      },
      ctx.contracts.inboxCoti.address,
      functionSelector
    );
  }

  const signature =
    typeof it.signature === "string"
      ? (it.signature as `0x${string}`)
      : toHex(it.signature as any);

  return {
    ciphertext: it.ciphertext,
    signature,
  };
};

// Decode a ctUint256 structure.
export const decodeCtUint256 = (
  encryptedResult: unknown
): { ciphertextHigh: bigint; ciphertextLow: bigint } => {
  const ciphertextHigh = getTupleField(encryptedResult, "ciphertextHigh", 0);
  const ciphertextLow = getTupleField(encryptedResult, "ciphertextLow", 1);
  return {
    ciphertextHigh: BigInt(ciphertextHigh ?? 0),
    ciphertextLow: BigInt(ciphertextLow ?? 0),
  };
};

// Decrypt a ctUint256 result into a 256-bit value.
export const decryptUint256 = (
  encryptedResult: unknown,
  userKey: string,
  _decryptFn?: (ct: bigint, key: string) => bigint
): bigint => {
  const { ciphertextHigh, ciphertextLow } = decodeCtUint256(encryptedResult);
  if (isSimCotiBackend()) {
    return decryptSimUint256({ ciphertextHigh, ciphertextLow }, userKey);
  }
  return sdkDecryptUint256({ ciphertextHigh, ciphertextLow }, userKey);
};

// Normalizes ciphertext into a bigint.
const normalizeCiphertextInternal = (ciphertext: unknown): bigint => {
  if (typeof ciphertext === "bigint") {
    return ciphertext;
  }
  if (ciphertext && typeof ciphertext === "object") {
    const maybeValue = (ciphertext as { value?: bigint[] }).value;
    if (Array.isArray(maybeValue) && maybeValue.length > 0) {
      return BigInt(maybeValue[0]);
    }
  }
  return BigInt(ciphertext as any);
};

// Builds the shared MPC test context with deployments and wallets.
export const setupContext = async (params: {
  sepoliaViem: any;
  cotiViem: any;
  /** Defaults to `MpcAdder`; use `MpcAdderPausable` for retry/pause system tests. */
  podAdderContractName?: "MpcAdder" | "MpcAdderPausable";
}): Promise<TestContext> => {
  const simBackend = ["sim", "simcoti"].includes((process.env.COTI_BACKEND ?? "").trim().toLowerCase());
  const cotiRpcUrl = simBackend
    ? process.env.SIM_COTI_RPC_URL || process.env.COTI_TESTNET_RPC_URL || "http://127.0.0.1:8546"
    : requireEnv("COTI_TESTNET_RPC_URL");
  const cotiPrivateKeyMain = normalizePrivateKey(await resolveCotiTestnetPrivateKey(cotiRpcUrl));

  const sepoliaChainId = parseInt(process.env.HARDHAT_CHAIN_ID || "31337");
  // simCoti Hardhat network uses 7082401; live testnet is 7082400.
  const cotiChainId = BigInt(
    parseInt(
      simBackend
        ? process.env.SIM_COTI_CHAIN_ID || "7082401"
        : process.env.COTI_TESTNET_CHAIN_ID || "7082400",
      10
    )
  );
  const cotiDeploymentsPath =
    process.env.COTI_DEPLOYMENTS_PATH || path.resolve(process.cwd(), "deployments", "coti-testnet.json");

  logStep("Preparing chain clients");
  const cotiChain = defineChain({
    id: Number(cotiChainId),
    name: simBackend ? "simCoti" : "COTI Testnet",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: {
      default: { http: [cotiRpcUrl] },
    },
  });

  const sepoliaPublicClient = await params.sepoliaViem.getPublicClient();
  const cotiPublicClient = await params.cotiViem.getPublicClient({ chain: cotiChain });
  const [sepoliaWallet] = await params.sepoliaViem.getWalletClients();
  const cotiAccount = privateKeyToAccount(cotiPrivateKeyMain as `0x${string}`);
  const hardhatCotiWallet = await params.sepoliaViem.getWalletClient(cotiAccount.address);
  const cotiWallet = await params.cotiViem.getWalletClient(cotiAccount.address, { chain: cotiChain });

  const inboxSepoliaAddress = envOrEmpty("HARDHAT_INBOX_ADDRESS") || envOrEmpty("SEPOLIA_INBOX_ADDRESS");
  const mpcAdderAddress =
    envOrEmpty("HARDHAT_MPC_ADDER_ADDRESS") || envOrEmpty("SEPOLIA_MPC_ADDER_ADDRESS");

  // Cache the COTI deployments to save gas between multiple tests.
  const cachedCoti = await readCotiDeployments(cotiDeploymentsPath);
  const inboxCotiAddress = envOrEmpty("COTI_INBOX_ADDRESS") || cachedCoti.inbox || "";
  const mpcExecutorAddress =
    envOrEmpty("COTI_MPC_EXECUTOR_ADDRESS") || cachedCoti.mpcExecutor || "";

  const reuseSepolia = !!(inboxSepoliaAddress && mpcAdderAddress);
  let reuseCoti =
    envOrEmpty("COTI_REUSE_CONTRACTS").toLowerCase() === "true" &&
    !!inboxCotiAddress &&
    !!mpcExecutorAddress;
  const allowFreshHardhat =
    envOrEmpty("COTI_REUSE_ALLOW_FRESH_HARDHAT").toLowerCase() === "true" ||
    envOrEmpty("COTI_REUSE_ALLOW_FRESH_HARDHAT") === "1";
  if (reuseCoti && !reuseSepolia && !allowFreshHardhat) {
    logStep(
      "COTI_REUSE_CONTRACTS ignored: reusing COTI with a freshly deployed Hardhat inbox breaks mined-request nonce alignment. Set HARDHAT_INBOX_ADDRESS and HARDHAT_MPC_ADDER_ADDRESS (or SEPOLIA_*), or COTI_REUSE_ALLOW_FRESH_HARDHAT=1 when mineRequest uses outbound request.requestId."
    );
    reuseCoti = false;
  } else if (reuseCoti && !reuseSepolia && allowFreshHardhat) {
    logStep(
      "COTI_REUSE_CONTRACTS: reusing COTI inbox/executor with a fresh Hardhat inbox (COTI_REUSE_ALLOW_FRESH_HARDHAT=1)"
    );
  }

  const podAdderContractName = params.podAdderContractName ?? "MpcAdder";

  let inboxSepolia: any;
  let mpcAdder: any;
  if (reuseSepolia) {
    logStep(`Reusing Hardhat contracts: Inbox=${inboxSepoliaAddress} ${podAdderContractName}=${mpcAdderAddress}`);
    inboxSepolia = await params.sepoliaViem.getContractAt("Inbox", inboxSepoliaAddress as `0x${string}`);
    mpcAdder = await params.sepoliaViem.getContractAt(podAdderContractName, mpcAdderAddress as `0x${string}`);
  } else {
    logStep(`Deploying Hardhat Inbox + ${podAdderContractName}`);
    inboxSepolia = await deployInboxWithInit(params.sepoliaViem, BigInt(sepoliaChainId));
    mpcAdder = await params.sepoliaViem.deployContract(podAdderContractName, [inboxSepolia.address]);
  }

  await fundContractForInboxFees(hardhatCotiWallet, sepoliaPublicClient, mpcAdder.address as `0x${string}`);

  const mpcAdderAsCoti = await params.sepoliaViem.getContractAt(podAdderContractName, mpcAdder.address, {
    client: {
      public: sepoliaPublicClient,
      wallet: hardhatCotiWallet,
    },
  });

  let inboxCoti: any;
  let mpcExecutor: any;
  if (reuseCoti) {
    logStep(`Reusing COTI contracts: Inbox=${inboxCotiAddress} MpcExecutor=${mpcExecutorAddress}`);
    inboxCoti = await params.cotiViem.getContractAt("Inbox", inboxCotiAddress as `0x${string}`, {
      client: { public: cotiPublicClient, wallet: cotiWallet },
    });
    mpcExecutor = await params.cotiViem.getContractAt(
      "MpcExecutor",
      mpcExecutorAddress as `0x${string}`,
      {
        client: { public: cotiPublicClient, wallet: cotiWallet },
      }
    );
  } else {
    logStep("Deploying COTI Inbox + MpcExecutor");
    inboxCoti = await deployInboxWithInit(params.cotiViem, BigInt(cotiChainId), {
      client: {
        public: cotiPublicClient,
        wallet: cotiWallet,
      },
    } as any);
    mpcExecutor = await params.cotiViem.deployContract(
      "MpcExecutor",
      [inboxCoti.address],
      {
        client: {
          public: cotiPublicClient,
          wallet: cotiWallet,
        },
      } as any
    );
    await writeCotiDeployments(cotiDeploymentsPath, {
      inbox: inboxCoti.address,
      mpcExecutor: mpcExecutor.address,
    });
    logStep(`Saved COTI deployments to ${cotiDeploymentsPath}`);
  }
  logStep(`COTI inbox address in use: ${inboxCoti.address}`);

  await ensureMpcInboxOracleAndFees({
    label: "Hardhat inbox",
    viem: params.sepoliaViem,
    publicClient: sepoliaPublicClient,
    walletClient: sepoliaWallet,
    chainId: sepoliaChainId,
    inbox: inboxSepolia,
  });
  await ensureMpcInboxOracleAndFees({
    label: "COTI inbox",
    viem: params.cotiViem,
    publicClient: cotiPublicClient,
    walletClient: cotiWallet,
    chainId: Number(cotiChainId),
    inbox: inboxCoti,
  });

  const podTwoWayFees = await estimateGas(inboxSepolia);

  if (!reuseSepolia || !reuseCoti) {
    logStep("Configuring COTI executor + miner");
    await mpcAdder.write.configure(podConfigureKeepInbox(mpcExecutor.address, cotiChainId));
    const cotiOwner = await inboxCoti.read.owner();
    logStep(`COTI inbox owner ${cotiOwner}`);
    const alreadyMiner = await inboxCoti.read.isMiner([cotiWallet.account.address]);
    if (!alreadyMiner) {
      logStep(`Adding COTI miner ${cotiWallet.account.address}`);
      const addMinerTx = await inboxCoti.write.addMiner([cotiWallet.account.address], {
        account: cotiWallet.account,
      });
      await cotiPublicClient.waitForTransactionReceipt({ hash: addMinerTx, ...receiptWaitOptions });
      const confirmedMiner = await inboxCoti.read.isMiner([cotiWallet.account.address]);
      logStep(`COTI miner confirmed=${confirmedMiner}`);
    } else {
      logStep("COTI miner already configured");
    }
  } else {
    logStep("Skipping configure/addMiner (reused contracts)");
  }

  const sepoliaMiner = sepoliaWallet.account.address;
  const sepoliaAlreadyMiner = await inboxSepolia.read.isMiner([sepoliaMiner]);
  if (!sepoliaAlreadyMiner) {
    logStep(`Adding Sepolia miner ${sepoliaMiner}`);
    await inboxSepolia.write.addMiner([sepoliaMiner]);
  } else {
    logStep("Sepolia miner already configured");
  }

  const cotiPrivateKey = await resolveCotiTestnetPrivateKey(cotiRpcUrl);
  const onboardAddress = process.env.COTI_ONBOARD_CONTRACT_ADDRESS || ONBOARD_CONTRACT_ADDRESS;
  const userKey = await onboardUser(cotiPrivateKey, cotiRpcUrl, onboardAddress);
  let cotiEncryptWallet: CotiWallet | SimWallet;
  if (simBackend) {
    const { registerUserOnSim } = await import("../sim-coti/sim-coti-utils.js");
    const cotiAccountForSim = privateKeyToAccount(normalizePrivateKey(cotiPrivateKey) as `0x${string}`);
    await registerUserOnSim(params.cotiViem, cotiAccountForSim.address, userKey, cotiAccountForSim);
    logStep(`simCoti: registered owner AES key for ${cotiAccountForSim.address}`);
    const provider = {
      send: async () => null,
      getNetwork: async () => ({ chainId: Number(cotiChainId) }),
    } as unknown as JsonRpcProvider;
    cotiEncryptWallet = new SimWallet(normalizePrivateKey(cotiPrivateKey) as Hex, provider, {
      chainId: Number(cotiChainId),
      aesKey: userKey,
    });
  } else {
    const cotiProvider = new JsonRpcProvider(cotiRpcUrl) as any;
    cotiEncryptWallet = new CotiWallet(cotiPrivateKey, cotiProvider as any);
    cotiEncryptWallet.setAesKey(userKey);
  }

  logStep("Setup complete");

  return {
    sepolia: { publicClient: sepoliaPublicClient, wallet: sepoliaWallet },
    coti: { publicClient: cotiPublicClient, wallet: cotiWallet },
    contracts: { inboxSepolia, inboxCoti, mpcAdder, mpcAdderAsCoti, mpcExecutor },
    crypto: { userKey, cotiEncryptWallet: cotiEncryptWallet as CotiWallet },
    chainIds: { sepolia: sepoliaChainId, coti: cotiChainId },
    podTwoWayFees,
  };
};

/** Context for PodAdder128 / PodAdder256 system tests (same shape as TestContext, different adder contract). */
export type TestContextWideMpc = {
  sepolia: TestContext["sepolia"];
  coti: TestContext["coti"];
  contracts: Omit<TestContext["contracts"], "mpcAdder" | "mpcAdderAsCoti"> & {
    mpcAdder: any;
    mpcAdderAsCoti: any;
  };
  crypto: TestContext["crypto"];
  chainIds: TestContext["chainIds"];
  podTwoWayFees: PodTwoWayFeeEstimate;
};

/** Configuration for {@link setupContextWideMpc} (128 vs 256 adder + deployments file + env keys). */
export type MpcWideSetupConfig = {
  podAdderContractName: "PodAdder128" | "PodAdder256";
  cotiDeploymentsFile: string;
  envHardhatMpcAdder: string;
  envSepoliaMpcAdder: string;
};

/**
 * Deploy/reuse Inbox + PodAdder128 or PodAdder256 on Hardhat and Inbox + MpcExecutor on COTI.
 * Same flow as {@link setupContext} but parameterized for wide MPC adder contracts.
 */
export const setupContextWideMpc = async (
  params: { sepoliaViem: any; cotiViem: any },
  config: MpcWideSetupConfig
): Promise<TestContextWideMpc> => {
  const cotiRpcUrl = requireEnv("COTI_TESTNET_RPC_URL");
  const cotiPrivateKeyMain = normalizePrivateKey(await resolveCotiTestnetPrivateKey(cotiRpcUrl));

  const sepoliaChainId = parseInt(process.env.HARDHAT_CHAIN_ID || "31337");
  const cotiChainId = BigInt(parseInt(process.env.COTI_TESTNET_CHAIN_ID || "7082400"));
  const cotiDeploymentsPath =
    process.env.COTI_DEPLOYMENTS_PATH ||
    path.resolve(process.cwd(), "deployments", config.cotiDeploymentsFile);

  logStep("Preparing chain clients");
  const cotiChain = defineChain({
    id: Number(cotiChainId),
    name: "COTI Testnet",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: {
      default: { http: [cotiRpcUrl] },
    },
  });

  const sepoliaPublicClient = await params.sepoliaViem.getPublicClient();
  const cotiPublicClient = await params.cotiViem.getPublicClient({ chain: cotiChain });
  const [sepoliaWallet] = await params.sepoliaViem.getWalletClients();
  const cotiAccount = privateKeyToAccount(cotiPrivateKeyMain as `0x${string}`);
  const hardhatCotiWallet = await params.sepoliaViem.getWalletClient(cotiAccount.address);
  const cotiWallet = await params.cotiViem.getWalletClient(cotiAccount.address, { chain: cotiChain });

  const inboxSepoliaAddress =
    envOrEmpty("HARDHAT_INBOX_ADDRESS") || envOrEmpty("SEPOLIA_INBOX_ADDRESS");
  const mpcAdderAddress =
    envOrEmpty(config.envHardhatMpcAdder) || envOrEmpty(config.envSepoliaMpcAdder);

  const cachedCoti = await readCotiDeployments(cotiDeploymentsPath);
  const inboxCotiAddress = envOrEmpty("COTI_INBOX_ADDRESS") || cachedCoti.inbox || "";
  const mpcExecutorAddress =
    envOrEmpty("COTI_MPC_EXECUTOR_ADDRESS") || cachedCoti.mpcExecutor || "";

  const reuseSepolia = !!(inboxSepoliaAddress && mpcAdderAddress);
  let reuseCoti =
    envOrEmpty("COTI_REUSE_CONTRACTS").toLowerCase() === "true" &&
    !!inboxCotiAddress &&
    !!mpcExecutorAddress;
  if (reuseCoti && !reuseSepolia) {
    logStep(
      "COTI_REUSE_CONTRACTS ignored: reusing COTI with a freshly deployed Hardhat inbox breaks mined-request nonce alignment. Set HARDHAT_INBOX_ADDRESS and HARDHAT_MPC_ADDER_* (or SEPOLIA_*) to reuse both sides."
    );
    reuseCoti = false;
  }

  let inboxSepolia: any;
  let mpcAdder: any;
  if (reuseSepolia) {
    logStep(
      `Reusing Hardhat contracts: Inbox=${inboxSepoliaAddress} ${config.podAdderContractName}=${mpcAdderAddress}`
    );
    inboxSepolia = await params.sepoliaViem.getContractAt("Inbox", inboxSepoliaAddress as `0x${string}`);
    mpcAdder = await params.sepoliaViem.getContractAt(
      config.podAdderContractName,
      mpcAdderAddress as `0x${string}`
    );
  } else {
    logStep(`Deploying Hardhat Inbox + ${config.podAdderContractName}`);
    inboxSepolia = await deployInboxWithInit(params.sepoliaViem, BigInt(sepoliaChainId));
    mpcAdder = await params.sepoliaViem.deployContract(config.podAdderContractName, [
      inboxSepolia.address,
    ]);
  }

  await fundContractForInboxFees(hardhatCotiWallet, sepoliaPublicClient, mpcAdder.address as `0x${string}`);

  const mpcAdderAsCoti = await params.sepoliaViem.getContractAt(
    config.podAdderContractName,
    mpcAdder.address,
    {
      client: {
        public: sepoliaPublicClient,
        wallet: hardhatCotiWallet,
      },
    }
  );

  let inboxCoti: any;
  let mpcExecutor: any;
  if (reuseCoti) {
    logStep(`Reusing COTI contracts: Inbox=${inboxCotiAddress} MpcExecutor=${mpcExecutorAddress}`);
    inboxCoti = await params.cotiViem.getContractAt("Inbox", inboxCotiAddress as `0x${string}`, {
      client: { public: cotiPublicClient, wallet: cotiWallet },
    });
    mpcExecutor = await params.cotiViem.getContractAt(
      "MpcExecutor",
      mpcExecutorAddress as `0x${string}`,
      {
        client: { public: cotiPublicClient, wallet: cotiWallet },
      }
    );
  } else {
    logStep("Deploying COTI Inbox + MpcExecutor");
    inboxCoti = await deployInboxWithInit(params.cotiViem, BigInt(cotiChainId), {
      client: {
        public: cotiPublicClient,
        wallet: cotiWallet,
      },
    } as any);
    mpcExecutor = await params.cotiViem.deployContract(
      "MpcExecutor",
      [inboxCoti.address],
      {
        client: {
          public: cotiPublicClient,
          wallet: cotiWallet,
        },
      } as any
    );
    await writeCotiDeployments(cotiDeploymentsPath, {
      inbox: inboxCoti.address,
      mpcExecutor: mpcExecutor.address,
    });
    logStep(`Saved COTI deployments to ${cotiDeploymentsPath}`);
  }
  logStep(`COTI inbox address in use: ${inboxCoti.address}`);

  await ensureMpcInboxOracleAndFees({
    label: "Hardhat inbox",
    viem: params.sepoliaViem,
    publicClient: sepoliaPublicClient,
    walletClient: sepoliaWallet,
    chainId: sepoliaChainId,
    inbox: inboxSepolia,
  });
  await ensureMpcInboxOracleAndFees({
    label: "COTI inbox",
    viem: params.cotiViem,
    publicClient: cotiPublicClient,
    walletClient: cotiWallet,
    chainId: Number(cotiChainId),
    inbox: inboxCoti,
  });

  const podTwoWayFees = await estimateGas(inboxSepolia);

  if (!reuseSepolia || !reuseCoti) {
    logStep("Configuring COTI executor + miner");
    await mpcAdder.write.configure(podConfigureKeepInbox(mpcExecutor.address, cotiChainId));
    const cotiOwner = await inboxCoti.read.owner();
    logStep(`COTI inbox owner ${cotiOwner}`);
    const alreadyMiner = await inboxCoti.read.isMiner([cotiWallet.account.address]);
    if (!alreadyMiner) {
      logStep(`Adding COTI miner ${cotiWallet.account.address}`);
      const addMinerTx = await inboxCoti.write.addMiner([cotiWallet.account.address], {
        account: cotiWallet.account,
      });
      await cotiPublicClient.waitForTransactionReceipt({ hash: addMinerTx, ...receiptWaitOptions });
      const confirmedMiner = await inboxCoti.read.isMiner([cotiWallet.account.address]);
      logStep(`COTI miner confirmed=${confirmedMiner}`);
    } else {
      logStep("COTI miner already configured");
    }
  } else {
    logStep("Skipping configure/addMiner (reused contracts)");
  }

  const sepoliaMiner = sepoliaWallet.account.address;
  const sepoliaAlreadyMiner = await inboxSepolia.read.isMiner([sepoliaMiner]);
  if (!sepoliaAlreadyMiner) {
    logStep(`Adding Sepolia miner ${sepoliaMiner}`);
    await inboxSepolia.write.addMiner([sepoliaMiner]);
  } else {
    logStep("Sepolia miner already configured");
  }

  const cotiProvider = new JsonRpcProvider(cotiRpcUrl) as any;
  const cotiPrivateKey = await resolveCotiTestnetPrivateKey(cotiRpcUrl);
  const onboardAddress = process.env.COTI_ONBOARD_CONTRACT_ADDRESS || ONBOARD_CONTRACT_ADDRESS;
  const userKey = await onboardUser(cotiPrivateKey, cotiRpcUrl, onboardAddress);
  const cotiEncryptWallet = new CotiWallet(cotiPrivateKey, cotiProvider as any);
  cotiEncryptWallet.setAesKey(userKey);

  logStep("Setup complete");

  return {
    sepolia: { publicClient: sepoliaPublicClient, wallet: sepoliaWallet },
    coti: { publicClient: cotiPublicClient, wallet: cotiWallet },
    contracts: {
      inboxSepolia,
      inboxCoti,
      mpcAdder,
      mpcAdderAsCoti,
      mpcExecutor,
    },
    crypto: { userKey, cotiEncryptWallet },
    chainIds: { sepolia: sepoliaChainId, coti: cotiChainId },
    podTwoWayFees,
  };
};

export async function getCotiCrypto(privateKey: string, rpcUrl: string, keyEnv: string) {
  const cotiProvider = new JsonRpcProvider(rpcUrl) as any;
  const normalizedKey = normalizePrivateKey(privateKey);
  const cotiEncryptWallet = new CotiWallet(normalizedKey, cotiProvider as any);
  const onboardAddress = process.env.COTI_ONBOARD_CONTRACT_ADDRESS || ONBOARD_CONTRACT_ADDRESS;
  const userKey = await onboardUser(normalizedKey, rpcUrl, onboardAddress, keyEnv);
  cotiEncryptWallet.setAesKey(userKey);
  return { cotiEncryptWallet, userKey };
}

// Reads cached COTI deployments from disk.
const readCotiDeployments = async (deploymentsPath: string) => {
  try {
    const raw = await fs.readFile(deploymentsPath, "utf8");
    return JSON.parse(raw) as { inbox?: string; mpcExecutor?: string };
  } catch {
    return {};
  }
};

// Writes cached COTI deployments to disk.
const writeCotiDeployments = async (
  deploymentsPath: string,
  payload: { inbox: string; mpcExecutor: string }
) => {
  await fs.mkdir(path.dirname(deploymentsPath), { recursive: true });
  const data = {
    ...payload,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(deploymentsPath, JSON.stringify(data, null, 2));
};

// ---------------------------------------------------------------------------
// Pod harness (PodTest64 / PodTest128 / PodTest256)
// ---------------------------------------------------------------------------

export type PodTestContractName = "PodTest64" | "PodTest128" | "PodTest256";

const podTestEnvKeys = (name: PodTestContractName) => {
  switch (name) {
    case "PodTest64":
      return { hh: "HARDHAT_POD_TEST64_ADDRESS", sep: "SEPOLIA_POD_TEST64_ADDRESS" };
    case "PodTest128":
      return { hh: "HARDHAT_POD_TEST128_ADDRESS", sep: "SEPOLIA_POD_TEST128_ADDRESS" };
    case "PodTest256":
      return { hh: "HARDHAT_POD_TEST256_ADDRESS", sep: "SEPOLIA_POD_TEST256_ADDRESS" };
  }
};

export type PodTestContext = {
  sepolia: TestContext["sepolia"];
  coti: TestContext["coti"];
  contracts: {
    inboxSepolia: any;
    inboxCoti: any;
    mpcExecutor: any;
    podTest: any;
    podTestAsCoti: any;
  };
  crypto: TestContext["crypto"];
  chainIds: TestContext["chainIds"];
  podContractName: PodTestContractName;
  podTwoWayFees: PodTwoWayFeeEstimate;
};

/**
 * Like {@link setupContext} but deploys PodTest64/128/256 on Hardhat.
 * Reuses the same COTI inbox + MpcExecutor cache as other MPC tests.
 * After upgrading executor ops, pass `forceRedeployCotiExecutor: true`, set `COTI_REUSE_CONTRACTS=false`,
 * or delete `deployments/coti-testnet.json` so COTI picks up a matching `MpcExecutor`.
 */
export const setupPodTestContext = async (params: {
  sepoliaViem: any;
  cotiViem: any;
  podContractName: PodTestContractName;
  /** When true with `COTI_REUSE_CONTRACTS=true`, redeploy only `MpcExecutor` and keep the cached inbox. */
  forceRedeployCotiExecutor?: boolean;
}): Promise<PodTestContext> => {
  const cotiRpcUrl = requireEnv("COTI_TESTNET_RPC_URL");
  const cotiPrivateKeyMain = normalizePrivateKey(await resolveCotiTestnetPrivateKey(cotiRpcUrl));

  const { hh, sep } = podTestEnvKeys(params.podContractName);
  const sepoliaChainId = parseInt(process.env.HARDHAT_CHAIN_ID || "31337");
  const cotiChainId = BigInt(parseInt(process.env.COTI_TESTNET_CHAIN_ID || "7082400"));
  const cotiDeploymentsPath =
    process.env.COTI_DEPLOYMENTS_PATH || path.resolve(process.cwd(), "deployments", "coti-testnet.json");

  logStep("Preparing chain clients (pod test harness)");
  const cotiChain = defineChain({
    id: Number(cotiChainId),
    name: "COTI Testnet",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: {
      default: { http: [cotiRpcUrl] },
    },
  });

  const sepoliaPublicClient = await params.sepoliaViem.getPublicClient();
  const cotiPublicClient = await params.cotiViem.getPublicClient({ chain: cotiChain });
  const [sepoliaWallet] = await params.sepoliaViem.getWalletClients();
  const cotiAccount = privateKeyToAccount(cotiPrivateKeyMain as `0x${string}`);
  const hardhatCotiWallet = await params.sepoliaViem.getWalletClient(cotiAccount.address);
  const cotiWallet = await params.cotiViem.getWalletClient(cotiAccount.address, { chain: cotiChain });

  const inboxSepoliaAddress = envOrEmpty("HARDHAT_INBOX_ADDRESS") || envOrEmpty("SEPOLIA_INBOX_ADDRESS");
  const podAddress = envOrEmpty(hh) || envOrEmpty(sep);

  const cachedCoti = await readCotiDeployments(cotiDeploymentsPath);
  const inboxCotiAddress = envOrEmpty("COTI_INBOX_ADDRESS") || cachedCoti.inbox || "";
  const mpcExecutorAddress =
    envOrEmpty("COTI_MPC_EXECUTOR_ADDRESS") || cachedCoti.mpcExecutor || "";

  const reuseSepolia = !!(inboxSepoliaAddress && podAddress);
  const envReuseCoti = envOrEmpty("COTI_REUSE_CONTRACTS").toLowerCase() === "true";
  const cotiHasCache = !!inboxCotiAddress && !!mpcExecutorAddress;
  const forceRedeployCotiExecutor = params.forceRedeployCotiExecutor === true;
  let reuseCotiFull = envReuseCoti && cotiHasCache && !forceRedeployCotiExecutor;
  if (reuseCotiFull && !reuseSepolia) {
    logStep(
      "COTI_REUSE_CONTRACTS ignored for pod test: reusing COTI with a freshly deployed Hardhat inbox breaks mined-request nonce alignment. Set HARDHAT_INBOX_ADDRESS and the matching HARDHAT_POD_TEST64_ADDRESS / _128_ / _256_ (or SEPOLIA_*) to reuse both sides."
    );
    reuseCotiFull = false;
  }

  let inboxSepolia: any;
  let podTest: any;
  if (reuseSepolia) {
    logStep(`Reusing Hardhat: Inbox=${inboxSepoliaAddress} ${params.podContractName}=${podAddress}`);
    inboxSepolia = await params.sepoliaViem.getContractAt("Inbox", inboxSepoliaAddress as `0x${string}`);
    podTest = await params.sepoliaViem.getContractAt(
      params.podContractName,
      podAddress as `0x${string}`
    );
  } else {
    logStep(`Deploying Hardhat Inbox + ${params.podContractName}`);
    inboxSepolia = await deployInboxWithInit(params.sepoliaViem, BigInt(sepoliaChainId));
    podTest = await params.sepoliaViem.deployContract(params.podContractName, [inboxSepolia.address]);
  }

  await fundContractForInboxFees(hardhatCotiWallet, sepoliaPublicClient, podTest.address as `0x${string}`);

  const podTestAsCoti = await params.sepoliaViem.getContractAt(params.podContractName, podTest.address, {
    client: {
      public: sepoliaPublicClient,
      wallet: hardhatCotiWallet,
    },
  });

  let inboxCoti: any;
  let mpcExecutor: any;
  if (reuseCotiFull) {
    logStep(`Reusing COTI contracts: Inbox=${inboxCotiAddress} MpcExecutor=${mpcExecutorAddress}`);
    inboxCoti = await params.cotiViem.getContractAt("Inbox", inboxCotiAddress as `0x${string}`, {
      client: { public: cotiPublicClient, wallet: cotiWallet },
    });
    mpcExecutor = await params.cotiViem.getContractAt(
      "MpcExecutor",
      mpcExecutorAddress as `0x${string}`,
      {
        client: { public: cotiPublicClient, wallet: cotiWallet },
      }
    );
  } else if (envReuseCoti && forceRedeployCotiExecutor && inboxCotiAddress && reuseSepolia) {
    logStep(`Redeploying COTI MpcExecutor (keeping inbox ${inboxCotiAddress})`);
    inboxCoti = await params.cotiViem.getContractAt("Inbox", inboxCotiAddress as `0x${string}`, {
      client: { public: cotiPublicClient, wallet: cotiWallet },
    });
    mpcExecutor = await params.cotiViem.deployContract(
      "MpcExecutor",
      [inboxCoti.address],
      {
        client: {
          public: cotiPublicClient,
          wallet: cotiWallet,
        },
      } as any
    );
    await writeCotiDeployments(cotiDeploymentsPath, {
      inbox: inboxCotiAddress,
      mpcExecutor: mpcExecutor.address,
    });
    logStep(`Saved updated MpcExecutor to ${cotiDeploymentsPath}`);
  } else {
    if (envReuseCoti && forceRedeployCotiExecutor && inboxCotiAddress && !reuseSepolia) {
      logStep(
        "Redeploying COTI MpcExecutor alone skipped: fresh Hardhat inbox without HARDHAT_INBOX_ADDRESS + pod contract env reuse would desync mined nonces on COTI. Deploying new COTI inbox + MpcExecutor."
      );
    }
    logStep("Deploying COTI Inbox + MpcExecutor");
    inboxCoti = await deployInboxWithInit(params.cotiViem, BigInt(cotiChainId), {
      client: {
        public: cotiPublicClient,
        wallet: cotiWallet,
      },
    } as any);
    mpcExecutor = await params.cotiViem.deployContract(
      "MpcExecutor",
      [inboxCoti.address],
      {
        client: {
          public: cotiPublicClient,
          wallet: cotiWallet,
        },
      } as any
    );
    await writeCotiDeployments(cotiDeploymentsPath, {
      inbox: inboxCoti.address,
      mpcExecutor: mpcExecutor.address,
    });
    logStep(`Saved COTI deployments to ${cotiDeploymentsPath}`);
  }
  logStep(`COTI inbox address in use: ${inboxCoti.address}`);

  await ensureMpcInboxOracleAndFees({
    label: "Hardhat inbox (pod test)",
    viem: params.sepoliaViem,
    publicClient: sepoliaPublicClient,
    walletClient: sepoliaWallet,
    chainId: sepoliaChainId,
    inbox: inboxSepolia,
  });
  await ensureMpcInboxOracleAndFees({
    label: "COTI inbox (pod test)",
    viem: params.cotiViem,
    publicClient: cotiPublicClient,
    walletClient: cotiWallet,
    chainId: Number(cotiChainId),
    inbox: inboxCoti,
  });

  const podTwoWayFees = await estimateGas(inboxSepolia);

  if (!reuseSepolia || !reuseCotiFull) {
    logStep("Configuring COTI executor + miner (pod test)");
    await podTest.write.configure(podConfigureKeepInbox(mpcExecutor.address, cotiChainId));
    const cotiOwner = await inboxCoti.read.owner();
    logStep(`COTI inbox owner ${cotiOwner}`);
    const alreadyMiner = await inboxCoti.read.isMiner([cotiWallet.account.address]);
    if (!alreadyMiner) {
      logStep(`Adding COTI miner ${cotiWallet.account.address}`);
      const addMinerTx = await inboxCoti.write.addMiner([cotiWallet.account.address], {
        account: cotiWallet.account,
      });
      await cotiPublicClient.waitForTransactionReceipt({ hash: addMinerTx, ...receiptWaitOptions });
      const confirmedMiner = await inboxCoti.read.isMiner([cotiWallet.account.address]);
      logStep(`COTI miner confirmed=${confirmedMiner}`);
    } else {
      logStep("COTI miner already configured");
    }
  } else {
    logStep("Skipping configure/addMiner (reused Sepolia + full COTI cache)");
  }

  const sepoliaMiner = sepoliaWallet.account.address;
  const sepoliaAlreadyMiner = await inboxSepolia.read.isMiner([sepoliaMiner]);
  if (!sepoliaAlreadyMiner) {
    logStep(`Adding Sepolia miner ${sepoliaMiner}`);
    await inboxSepolia.write.addMiner([sepoliaMiner]);
  } else {
    logStep("Sepolia miner already configured");
  }

  const cotiProvider = new JsonRpcProvider(cotiRpcUrl) as any;
  const cotiPrivateKey = await resolveCotiTestnetPrivateKey(cotiRpcUrl);
  const onboardAddress = process.env.COTI_ONBOARD_CONTRACT_ADDRESS || ONBOARD_CONTRACT_ADDRESS;
  const userKey = await onboardUser(cotiPrivateKey, cotiRpcUrl, onboardAddress);
  const cotiEncryptWallet = new CotiWallet(cotiPrivateKey, cotiProvider as any);
  cotiEncryptWallet.setAesKey(userKey);

  logStep("Pod test setup complete");

  return {
    sepolia: { publicClient: sepoliaPublicClient, wallet: sepoliaWallet },
    coti: { publicClient: cotiPublicClient, wallet: cotiWallet },
    contracts: {
      inboxSepolia,
      inboxCoti,
      mpcExecutor,
      podTest,
      podTestAsCoti,
    },
    crypto: { userKey, cotiEncryptWallet },
    chainIds: { sepolia: sepoliaChainId, coti: cotiChainId },
    podContractName: params.podContractName,
    podTwoWayFees,
  };
};

/**
 * `PodTest*.lastResult` may be returned as raw `abi.encode(...)` (32 / 64 / 128 bytes) or as a full
 * ABI-encoded Solidity `bytes` (offset + length + payload). Normalize to the inner payload for decoders.
 */
export const unwrapPodLastResultPayload = (getterHex: `0x${string}`): `0x${string}` => {
  const hex = (getterHex.startsWith("0x") ? getterHex : (`0x${getterHex}` as const)) as `0x${string}`;
  const byteLen = (hex.length - 2) / 2;
  if (byteLen === 32 || byteLen === 64 || byteLen === 128) {
    return hex;
  }
  try {
    const [inner] = decodeAbiParameters([{ type: "bytes", name: "payload" }], hex);
    return inner as `0x${string}`;
  } catch {
    return hex;
  }
};

/**
 * Default gas for PodTest256 `exec*` on Hardhat (overridable via `MineRequestOptions.hardhatGas` or `POD_OPS_HARDHAT_GAS`).
 * Must stay ≤ {@link HARDHAT_EDR_TX_GAS_CAP}.
 */
export const DEFAULT_POD_HARDHAT_GAS_256 = HARDHAT_EDR_TX_GAS_CAP;

/** Mine COTI + Sepolia round-trip for a pod exec tx; returns raw `lastResult` bytes (hex). */
export const runPodRoundTrip = async (
  ctx: PodTestContext,
  label: string,
  send: (podAsCoti: any, writeOpts?: { gas?: bigint; value?: bigint }) => Promise<`0x${string}`>,
  mineOptions?: MineRequestOptions
): Promise<`0x${string}`> => {
  const hardhatGasFromEnv = process.env.POD_OPS_HARDHAT_GAS?.trim();
  const envHardhatGas = hardhatGasFromEnv ? BigInt(hardhatGasFromEnv) : undefined;
  const hardhatWriteGasRaw =
    mineOptions?.hardhatGas ??
    envHardhatGas ??
    (ctx.podContractName === "PodTest256" ? DEFAULT_POD_HARDHAT_GAS_256 : undefined);
  const hardhatWriteGas =
    hardhatWriteGasRaw !== undefined && hardhatWriteGasRaw > HARDHAT_EDR_TX_GAS_CAP
      ? HARDHAT_EDR_TX_GAS_CAP
      : hardhatWriteGasRaw;
  const gasOpts = hardhatWriteGas !== undefined ? { gas: hardhatWriteGas } : {};
  const writeOpts = { ...podTwoWayWriteOptions(ctx.podTwoWayFees), ...gasOpts };
  const txHash = await send(ctx.contracts.podTestAsCoti, writeOpts);
  await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
  const request = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);
  const defaultGas =
    ctx.podContractName === "PodTest256"
      ? DEFAULT_COTI_MINE_GAS_MPC_256
      : ctx.podContractName === "PodTest128"
        ? DEFAULT_COTI_MINE_GAS_MPC_128
        : undefined;
  const merged: MineRequestOptions | undefined =
    defaultGas !== undefined
      ? { ...mineOptions, gas: mineOptions?.gas ?? defaultGas }
      : mineOptions;
  const { requestIdUsed } = await mineRequest(
    ctx,
    "coti",
    BigInt(ctx.chainIds.sepolia),
    request,
    label,
    merged
  );
  const responseRequest = await getResponseRequestBySource(ctx.contracts.inboxCoti, requestIdUsed, label);
  // Pod tests use Hardhat as the "Sepolia" chain. EDR caps single-tx gas at 16777216; reusing COTI mine
  // gas (e.g. 50M for mul256) here makes `batchProcessRequests` fail before broadcast.
  const localMineOpts: MineRequestOptions | undefined =
    merged?.nonceOverride !== undefined ? { nonceOverride: merged.nonceOverride } : undefined;
  await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, label, localMineOpts);
  const getterHex = (await ctx.contracts.podTest.read.lastResult()) as `0x${string}`;
  return unwrapPodLastResultPayload(getterHex);
};

/** `abi.encode(ctUint64)` / `ctBool` payload: single uint256 word. */
export const decodePodCtUint64Word = (data: `0x${string}`): bigint => {
  const [v] = decodeAbiParameters([{ type: "uint256", name: "w" }], data);
  return v as bigint;
};

/** `abi.encode(uint256)` plaintext (e.g. executor `rand*` / `randBoundedBits*` responses). */
export const decodePodPlainUint256 = (data: `0x${string}`): bigint => {
  const [v] = decodeAbiParameters([{ type: "uint256", name: "v" }], data);
  return v as bigint;
};

/** Decode `abi.encode(ctUint128)` from executor respond payload (single uint256 ciphertext). */
export const decodePodCtUint128Struct = (data: `0x${string}`): bigint => {
  const [v] = decodeAbiParameters([{ type: "uint256", name: "ciphertext" }], data);
  return v as bigint;
};

/** Decode `abi.encode(ctUint256)` from executor respond payload. */
export const decodePodCtUint256Struct = (
  data: `0x${string}`
): { ciphertextHigh: bigint; ciphertextLow: bigint } => {
  const [t] = decodeAbiParameters(
    [
      {
        type: "tuple",
        name: "ct",
        components: [
          { name: "ciphertextHigh", type: "uint256" },
          { name: "ciphertextLow", type: "uint256" },
        ],
      },
    ],
    data
  );
  return t as { ciphertextHigh: bigint; ciphertextLow: bigint };
};

/**
 * Encrypt 0/1 using the same path as {@link buildEncryptedInput} (64-bit input text), validated on-chain as `itBool`.
 * `MpcExecutor.mux*` compensates so plaintext `1` still selects the first uint branch and `0` the second.
 */
export const buildEncryptedBool = async (ctx: MpcEncryptContext, bit: 0 | 1) =>
  buildEncryptedInput(ctx, BigInt(bit));

