/**
 * SimCOTI local test harness — no live COTI testnet required.
 *
 * Use from `test/sim-coti/*` for local-only integration tests.
 * System tests (`test/system/*`) may use the same helpers when `COTI_BACKEND=sim`.
 *
 * Network modes (`SIM_COTI_NETWORK_MODE`):
 * - `inprocess` (default): Hardhat EDR via `network.connect` — fast, CI-friendly.
 * - `node`: external Hardhat nodes on ports 8545 (Sepolia surrogate) and 8546 (simCoti).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { JsonRpcProvider } from "ethers";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  injectSimCotiPrecompile,
  MPC_PRECOMPILE,
  type InjectSimCotiResult,
} from "../../simCOTI/hardhat/injectPrecompile.js";
import {
  SimWallet,
  deriveSimAesKey,
  decryptSimUint,
  decryptSimUint256,
  SIM_COTI_CHAIN_ID,
} from "../../simCOTI/sdk/index.js";
import {
  aesKeyToBigInt,
  simEncryptUint128,
  buildSimItSignature,
  simDecryptUint128,
} from "../../simCOTI/sdk/crypto.js";
import type { CtUint256, ItUint128, ItUint256, ItUint64 } from "../../simCOTI/sdk/types.js";
import type { TestContext } from "../system/mpc-test-utils.js";
import { isSimCotiBackend, resolveCotiNetworkName } from "../../simCOTI/test/coti-network.js";

export {
  MPC_PRECOMPILE,
  SIM_COTI_CHAIN_ID,
  SimWallet,
  type InjectSimCotiResult,
};

export type SimCotiNetworkMode = "inprocess" | "node";

export type SimCotiNetworks = {
  mode: SimCotiNetworkMode;
  sepoliaViem: Awaited<ReturnType<typeof network.connect>>["viem"];
  cotiViem: Awaited<ReturnType<typeof network.connect>>["viem"];
  stop?: () => Promise<void>;
};

const DEFAULT_SEPOLIA_PORT = 8545;
const DEFAULT_COTI_PORT = 8546;
const SEPOLIA_CHAIN_ID = 31337;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Read network mode from env; defaults to in-process EDR. */
export function resolveSimCotiNetworkMode(): SimCotiNetworkMode {
  const raw = process.env.SIM_COTI_NETWORK_MODE?.trim().toLowerCase();
  return raw === "node" ? "node" : "inprocess";
}

/**
 * Connect Hardhat (Sepolia surrogate) + COTI side for integration tests.
 * Uses simCoti when `COTI_BACKEND=sim`, live testnet otherwise.
 * Injects the fake MPC precompile when sim.
 */
export async function connectDualChainForTests(): Promise<SimCotiNetworks> {
  if (isSimCotiBackend()) {
    const nets = await startSimCotiNetworks();
    await initSimCoti(nets.cotiViem);
    return nets;
  }
  const { viem: sepoliaViem } = await network.connect({ network: "hardhat" });
  const { viem: cotiViem } = await network.connect({ network: resolveCotiNetworkName() });
  return { mode: "inprocess", sepoliaViem, cotiViem };
}

/** Force local sim backend (never live COTI testnet). */
export function forceSimCotiBackend(): void {
  process.env.COTI_BACKEND = "sim";
}

// TCP-level probe, not an RPC-level one: a slow-starting `hardhat node` accepts the
// connection as soon as it calls listen(), well before its HTTP/JSON-RPC handler is
// ready to respond. Checking for an actual RPC response here (as an earlier version
// of this function did) leaves a race window where a starting-but-not-yet-answering
// node reads as "not up", so a second `hardhat node` gets spawned onto the same port
// anyway. A raw connect also correctly treats *any* listener on the port (RPC or not)
// as "occupied" rather than assuming it's safe to bind. Actual RPC readiness is still
// confirmed afterward by waitForRpc.
async function isPortBound(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function waitForRpc(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: string };
        if (json.result) return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`RPC not ready at ${url} after ${timeoutMs}ms`);
}

function spawnHardhatNode(port: number, chainId: number): ChildProcess {
  return spawn(
    "npx",
    ["hardhat", "node", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: repoRoot,
      env: { ...process.env, HARDHAT_CHAIN_ID: String(chainId) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

async function stopChild(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.killed) return;
  proc.kill("SIGTERM");
  await Promise.race([once(proc, "exit"), new Promise((r) => setTimeout(r, 3000))]);
  if (!proc.killed) proc.kill("SIGKILL");
}

/**
 * Start Sepolia-surrogate (hardhat) + simCoti networks.
 * In-process mode uses EDR; node mode spawns two Hardhat nodes.
 */
export async function startSimCotiNetworks(opts?: {
  mode?: SimCotiNetworkMode;
  sepoliaPort?: number;
  cotiPort?: number;
}): Promise<SimCotiNetworks> {
  const mode = opts?.mode ?? resolveSimCotiNetworkMode();

  if (mode === "inprocess") {
    const { viem: sepoliaViem } = await network.connect({ network: "hardhat" });
    const { viem: cotiViem } = await network.connect({ network: "simCoti" });
    return { mode, sepoliaViem, cotiViem };
  }

  const sepoliaPort = opts?.sepoliaPort ?? DEFAULT_SEPOLIA_PORT;
  const cotiPort = opts?.cotiPort ?? DEFAULT_COTI_PORT;

  // Skip spawning when a devnet (e.g. scripts/devnet/start.sh) already owns these ports.
  // Spawning a second, immediately-port-conflicting `hardhat node` and then reaping its
  // exit has been observed to crash Node's child-process handling on some platforms.
  const [sepoliaAlreadyUp, cotiAlreadyUp] = await Promise.all([
    isPortBound(sepoliaPort),
    isPortBound(cotiPort),
  ]);

  const sepoliaProc = sepoliaAlreadyUp ? undefined : spawnHardhatNode(sepoliaPort, SEPOLIA_CHAIN_ID);
  const cotiProc = cotiAlreadyUp ? undefined : spawnHardhatNode(cotiPort, SIM_COTI_CHAIN_ID);

  await Promise.all([
    waitForRpc(`http://127.0.0.1:${sepoliaPort}`),
    waitForRpc(`http://127.0.0.1:${cotiPort}`),
  ]);

  const { viem: sepoliaViem } = await network.connect({ network: "localSepolia" });
  const { viem: cotiViem } = await network.connect({ network: "localSimCoti" });

  return {
    mode,
    sepoliaViem,
    cotiViem,
    stop: async () => {
      await Promise.all([stopChild(sepoliaProc), stopChild(cotiProc)]);
    },
  };
}

/** Deploy SimState + proxy and inject fake MPC precompile at 0x64 (idempotent per viem instance). */
export async function initSimCoti(
  cotiViem: SimCotiNetworks["cotiViem"]
): Promise<InjectSimCotiResult> {
  return injectSimCotiPrecompile(cotiViem);
}

/** Deterministic sim AES key from a private key and sim chain id. */
export function deriveUserAesKey(
  privateKey: Hex | string,
  chainId = SIM_COTI_CHAIN_ID
): string {
  const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  return deriveSimAesKey(pk, chainId);
}

/** Register a user's AES key on the sim precompile (required before ValidateCiphertext). */
export async function registerUserOnSim(
  viem: SimCotiNetworks["cotiViem"],
  userAddress: `0x${string}`,
  aesKey: string | bigint,
  signerAccount?: PrivateKeyAccount
): Promise<void> {
  const keyBigInt = typeof aesKey === "bigint" ? aesKey : aesKeyToBigInt(aesKey);
  const sim = await viem.getContractAt("SimExtendedOperations", MPC_PRECOMPILE);
  const account = signerAccount ?? (await viem.getWalletClients())[0].account;
  await sim.write.simRegisterUserKey([userAddress, keyBigInt], { account });
}

/** Register the same AES key on both sim chains (AVAX surrogate + simCOTI). */
export async function registerUserOnDualSim(
  sepoliaViem: SimCotiNetworks["sepoliaViem"],
  cotiViem: SimCotiNetworks["cotiViem"],
  userAddress: `0x${string}`,
  aesKey: string | bigint,
  signerAccount?: PrivateKeyAccount
): Promise<void> {
  await registerUserOnSim(cotiViem, userAddress, aesKey, signerAccount);
  if (isSimCotiBackend()) {
    await registerUserOnSim(sepoliaViem, userAddress, aesKey, signerAccount);
  }
}

/** Derive AES key and register it on simCOTI (+ AVAX surrogate when sim backend). */
export async function onboardSimUser(
  cotiViem: SimCotiNetworks["cotiViem"],
  privateKey: Hex | string,
  signerAccount?: PrivateKeyAccount,
  sepoliaViem?: SimCotiNetworks["sepoliaViem"]
): Promise<{ userKey: string; address: `0x${string}` }> {
  const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  const account = signerAccount ?? privateKeyToAccount(pk);
  const userKey = deriveUserAesKey(pk);
  if (sepoliaViem && isSimCotiBackend()) {
    await registerUserOnDualSim(sepoliaViem, cotiViem, account.address, userKey, account);
  } else {
    await registerUserOnSim(cotiViem, account.address, userKey, account);
  }
  return { userKey, address: account.address };
}

/** Build a SimWallet for encrypt/decrypt in tests. */
export function createSimWallet(privateKey: Hex | string, aesKey?: string): SimWallet {
  const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  const provider = {
    send: async () => null,
    getNetwork: async () => ({ chainId: SIM_COTI_CHAIN_ID }),
  } as unknown as JsonRpcProvider;
  const wallet = new SimWallet(pk, provider, { chainId: SIM_COTI_CHAIN_ID, aesKey });
  if (aesKey) wallet.setAesKey(aesKey);
  return wallet;
}

export async function encryptUint64(
  wallet: SimWallet,
  plain: bigint | number,
  contractAddress: string,
  functionSelector: string
): Promise<ItUint64> {
  return wallet.encryptValue(plain, contractAddress, functionSelector);
}

export async function encryptUint128(
  wallet: SimWallet,
  plain: bigint | number,
  contractAddress: string,
  functionSelector: string
): Promise<ItUint128> {
  const key = wallet.getUserOnboardInfo()?.aesKey;
  if (!key) throw new Error("encryptUint128: SimWallet AES key not set");
  const ciphertext = simEncryptUint128(BigInt(plain), key);
  const signature = await buildSimItSignature({
    privateKey: wallet.getPrivateKey(),
    contractAddress: contractAddress as `0x${string}`,
    functionSelector: (functionSelector.startsWith("0x")
      ? functionSelector
      : `0x${functionSelector}`) as `0x${string}`,
    ciphertext,
  });
  return { ciphertext, signature };
}

export async function encryptUint256(
  wallet: SimWallet,
  plain: bigint | number,
  contractAddress: string,
  functionSelector: string
): Promise<ItUint256> {
  return wallet.encryptValue256(plain, contractAddress, functionSelector);
}

export function decryptUint64(ciphertext: bigint, userKey: string): bigint {
  return decryptSimUint(ciphertext, userKey, 64);
}

export function decryptUint128(ciphertext: bigint, userKey: string): bigint {
  return simDecryptUint128(ciphertext, userKey);
}

export function decryptUint256(ciphertext: CtUint256, userKey: string): bigint {
  return decryptSimUint256(ciphertext, userKey);
}

export type SimCryptoSetup = {
  userKey: string;
  cotiEncryptWallet: SimWallet;
};

/**
 * Sim-only crypto setup used by `setupContext` when `COTI_BACKEND=sim`.
 * Derives AES key, builds SimWallet, registers key on precompile.
 */
export async function setupSimCrypto(params: {
  cotiViem: SimCotiNetworks["cotiViem"];
  cotiPrivateKey: string;
  cotiAccount: PrivateKeyAccount;
  cotiPublicClient: unknown;
  cotiWallet: { account: PrivateKeyAccount };
}): Promise<SimCryptoSetup> {
  const pk = params.cotiPrivateKey as Hex;
  const userKey = deriveUserAesKey(pk);
  const cotiEncryptWallet = createSimWallet(pk, userKey);
  await registerUserOnSim(
    params.cotiViem,
    params.cotiAccount.address,
    userKey,
    params.cotiWallet.account
  );
  return { userKey, cotiEncryptWallet };
}

let cachedNetworks: SimCotiNetworks | undefined;
let cachedContext: TestContext | undefined;

/**
 * Full local simCoti test context: networks + precompile + PoD deployments.
 * Forces `COTI_BACKEND=sim` and reuses context within a test file.
 */
export async function createSimCotiContext(params?: {
  podAdderContractName?: "MpcAdder" | "MpcAdderPausable";
  reuseContracts?: boolean;
}): Promise<TestContext> {
  if (cachedContext) return cachedContext;

  forceSimCotiBackend();
  if (params?.reuseContracts !== false) {
    process.env.COTI_REUSE_CONTRACTS = "true";
  }

  if (!cachedNetworks) {
    cachedNetworks = await startSimCotiNetworks();
  }

  const { setupContext } = await import("../system/mpc-test-utils.js");
  cachedContext = await setupContext({
    sepoliaViem: cachedNetworks.sepoliaViem,
    cotiViem: cachedNetworks.cotiViem,
    podAdderContractName: params?.podAdderContractName,
  });
  return cachedContext;
}

/** Reset cached network handles (call between test files if needed). */
export async function resetSimCotiNetworks(): Promise<void> {
  cachedContext = undefined;
  if (cachedNetworks?.stop) await cachedNetworks.stop();
  cachedNetworks = undefined;
}
