/**
 * Deployment verification from `deployConfig.json`.
 *
 * 1. Prints inbox fee templates, gas-price bounds, oracle USD legs, and wiring for each deployed chain.
 * 2. For every source EVM with `mpcAdder` + COTI `cotiExecutor` (e.g. Sepolia, Fuji), runs
 *    `MpcAdder.add` → mine on COTI → mine callback on source (two-way round-trip) and decrypts a+b.
 *
 * Usage:
 *   npm run verify:deployments
 *   npm run verify:deployments -- --config-only
 *   npm run verify:deployments -- --chains=sepolia,avalancheFuji
 *
 * Requires PRIVATE_KEY (source) and COTI_TESTNET_PRIVATE_KEY (or PRIVATE_KEY) with miner rights on both inboxes.
 */
import "dotenv/config";
import { network } from "hardhat";
import { formatEther, formatUnits, toFunctionSelector, zeroAddress, type Address } from "viem";
import { ONBOARD_CONTRACT_ADDRESS, Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { decryptUint } from "@coti-io/coti-sdk-typescript";
import { JsonRpcProvider } from "ethers";
import {
  formatGasPriceBounds,
  gasPriceBoundsEq,
  getViemClients,
  optionalEnv,
  readDeployConfig,
  readFeeConfigForChain,
  readGasPriceBoundsForChain,
  resolveDeployerAddress,
  resolveRpcUrl,
  type GasPriceBoundsTuple,
} from "./deploy-utils.js";
import {
  buildEncryptedInput,
  decodeCtUint64,
  estimateGas,
  getLatestRequest,
  getResponseRequestBySource,
  getTupleField,
  onboardUser,
  parseRequest,
  podTwoWayWriteOptions,
  receiptWaitOptions,
  type Request,
} from "../test/system/mpc-test-utils.js";

const COTI_TESTNET_CHAIN_ID = 7082400;
const SOURCE_NETWORKS = [
  { name: "sepolia", chainId: 11155111, label: "Sepolia" },
  { name: "avalancheFuji", chainId: 43113, label: "Avalanche Fuji" },
] as const;

const FEE_FIELDS = [
  "constantFee",
  "gasPerByte",
  "callbackExecutionGas",
  "errorLength",
  "bufferRatioX10000",
] as const;

type FeeTuple = Record<(typeof FEE_FIELDS)[number], bigint>;

type ChainClients = {
  name: string;
  label: string;
  chainId: number;
  viem: any;
  publicClient: any;
  walletClient: any;
  deployer: Address;
};

const isAddr = (v: unknown): v is Address =>
  typeof v === "string" && v.startsWith("0x") && v.length === 42;

const CLI_FLAGS = process.argv.slice(2);
const CONFIG_ONLY = CLI_FLAGS.includes("--config-only") || CLI_FLAGS.includes("--skip-add");
const chainsFlag = CLI_FLAGS.find((f) => f.startsWith("--chains="));
const CHAIN_FILTER = chainsFlag
  ? new Set(
      chainsFlag
        .slice("--chains=".length)
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    )
  : null;

const hr = (title: string) => {
  console.log("\n" + "═".repeat(72));
  console.log(` ${title}`);
  console.log("═".repeat(72));
};

const section = (title: string) => {
  console.log(`\n── ${title}`);
};

const row = (key: string, value: unknown, ok?: boolean | null) => {
  const mark = ok === true ? "✓" : ok === false ? "✗" : "·";
  console.log(`  ${mark} ${key.padEnd(28)} ${value}`);
};

const normalizeFee = (raw: any): FeeTuple => {
  if (Array.isArray(raw)) {
    return {
      constantFee: BigInt(raw[0]),
      gasPerByte: BigInt(raw[1]),
      callbackExecutionGas: BigInt(raw[2]),
      errorLength: BigInt(raw[3]),
      bufferRatioX10000: BigInt(raw[4]),
    };
  }
  return {
    constantFee: BigInt(raw.constantFee),
    gasPerByte: BigInt(raw.gasPerByte),
    callbackExecutionGas: BigInt(raw.callbackExecutionGas),
    errorLength: BigInt(raw.errorLength),
    bufferRatioX10000: BigInt(raw.bufferRatioX10000),
  };
};

const formatFee = (f: FeeTuple): string =>
  `const=${f.constantFee} gas/byte=${f.gasPerByte} cbGas=${f.callbackExecutionGas} errLen=${f.errorLength} buf=${f.bufferRatioX10000}`;

const feeEq = (a: FeeTuple, b: FeeTuple): boolean => FEE_FIELDS.every((k) => a[k] === b[k]);

const usd18 = (v: bigint): string => {
  if (v === 0n) return "0";
  return `$${formatUnits(v, 18)}`;
};

const connectNetwork = async (name: string, label: string): Promise<ChainClients> => {
  const connection = await network.connect({ network: name });
  const { viem, provider, networkName } = connection;
  const { chainId, publicClient, walletClient } = await getViemClients(viem, provider, networkName);
  const deployer = await resolveDeployerAddress(walletClient);
  return { name, label, chainId, viem, publicClient, walletClient, deployer };
};

const getContract = async (clients: ChainClients, name: string, address: Address) =>
  clients.viem.getContractAt(name, address, {
    client: { public: clients.publicClient, wallet: clients.walletClient },
  });

/** Mine one inbound request on `dest` inbox (miner wallet must be registered). */
const mineInbound = async (params: {
  label: string;
  inbox: any;
  publicClient: any;
  walletClient: any;
  sourceChainId: bigint;
  request: Request;
  chainLabel: string;
}): Promise<`0x${string}`> => {
  const { label, inbox, publicClient, walletClient, sourceChainId, request, chainLabel } = params;
  const deployer = await resolveDeployerAddress(walletClient);
  const isMiner = await inbox.read.isMiner([deployer]);
  if (!isMiner) {
    throw new Error(
      `${label}: wallet ${deployer} is not a miner on ${chainLabel} inbox ${inbox.address}. ` +
        `Register with addMiner / MINER_ADDRESS during deploy.`
    );
  }

  let targetFee = request.targetFee > 0n ? request.targetFee : 2_500_000n;
  // EIP-150: outer gas must cover ceil(targetFee * 64/63) + headroom.
  const minOuter = (targetFee * 64n + 62n) / 63n + 4_000_000n;
  let gas = minOuter;
  if (chainLabel.toLowerCase().includes("coti")) {
    const blockGasLimit = BigInt(process.env.COTI_BLOCK_GAS_LIMIT ?? "120000000");
    if (gas > blockGasLimit) gas = blockGasLimit;
    const maxT = (blockGasLimit * 63n) / 64n - 4_000_000n;
    if (targetFee > maxT && maxT > 0n) targetFee = maxT;
  }

  console.log(`  → mining on ${chainLabel}: requestId=${request.requestId} targetFee=${targetFee} gas=${gas}`);
  const hash = (await inbox.write.batchProcessRequests(
    [
      sourceChainId,
      [
        {
          requestId: request.requestId,
          sourceContract: request.originalSender,
          targetContract: request.targetContract,
          methodCall: request.methodCall,
          callbackSelector: request.callbackSelector ?? "0x00000000",
          errorSelector: request.errorSelector ?? "0x00000000",
          isTwoWay: request.isTwoWay,
          sourceRequestId: request.sourceRequestId,
          targetFee,
          callerFee: request.callerFee,
        },
      ],
    ],
    { account: walletClient.account, gas }
  )) as `0x${string}`;

  const receipt = await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
  if (receipt.status !== "success") {
    throw new Error(`${label}: ${chainLabel} batchProcessRequests reverted: ${hash}`);
  }
  console.log(`  ✓ mined on ${chainLabel}: ${hash}`);
  return hash;
};

const printChainConfig = async (
  clients: ChainClients,
  chainCfg: Record<string, any>,
  role: "source" | "coti"
): Promise<{ inbox?: any; oracleOk: boolean; feesOk: boolean; boundsOk: boolean }> => {
  hr(`${clients.label} (chainId ${clients.chainId})`);
  row("role", role);
  row("deployer", clients.deployer);

  const inboxAddr = chainCfg.inbox;
  if (!isAddr(inboxAddr)) {
    row("inbox", "(not in deployConfig)", false);
    return { oracleOk: false, feesOk: false, boundsOk: false };
  }

  const code = await clients.publicClient.getBytecode({ address: inboxAddr });
  if (!code || code === "0x") {
    row("inbox", `${inboxAddr} (no code)`, false);
    return { oracleOk: false, feesOk: false, boundsOk: false };
  }

  const inbox = await getContract(clients, "Inbox", inboxAddr);
  const [owner, onChainId, priceOracleAddr, msgPaused] = await Promise.all([
    inbox.read.owner() as Promise<Address>,
    inbox.read.chainId() as Promise<bigint>,
    inbox.read.priceOracle() as Promise<Address>,
    inbox.read.messageProcessingPaused() as Promise<boolean>,
  ]);
  const isMiner = await inbox.read.isMiner([clients.deployer]);

  section("Inbox");
  row("address", inboxAddr, true);
  row("owner", owner, owner.toLowerCase() === clients.deployer.toLowerCase());
  row("chainId()", String(onChainId), Number(onChainId) === clients.chainId);
  row("messageProcessingPaused", String(msgPaused), !msgPaused);
  row("deployer is miner", String(isMiner), isMiner);

  section("Fee templates");
  const [rawLocal, rawRemote] = await Promise.all([
    inbox.read.localMinFeeConfig(),
    inbox.read.remoteMinFeeConfig(),
  ]);
  const onLocal = normalizeFee(rawLocal);
  const onRemote = normalizeFee(rawRemote);
  const desiredFees = await readFeeConfigForChain(clients.chainId);
  const feesOk = feeEq(onLocal, desiredFees.local) && feeEq(onRemote, desiredFees.remote);
  row("local (on-chain)", formatFee(onLocal));
  row("local (config)", formatFee(desiredFees.local as FeeTuple), feeEq(onLocal, desiredFees.local as FeeTuple));
  row("remote (on-chain)", formatFee(onRemote));
  row("remote (config)", formatFee(desiredFees.remote as FeeTuple), feeEq(onRemote, desiredFees.remote as FeeTuple));

  section("Gas price bounds (POD-07)");
  const onBounds: GasPriceBoundsTuple = {
    minPriorityFeeWei: await inbox.read.minPriorityFeeWei(),
    minGasPriceWei: await inbox.read.minGasPriceWei(),
    maxGasPriceWei: await inbox.read.maxGasPriceWei(),
  };
  const desiredBounds = await readGasPriceBoundsForChain(clients.chainId);
  const boundsOk = gasPriceBoundsEq(onBounds, desiredBounds);
  row("on-chain", formatGasPriceBounds(onBounds));
  row("config", formatGasPriceBounds(desiredBounds), boundsOk);
  if (clients.chainId === COTI_TESTNET_CHAIN_ID || clients.chainId === 2632500) {
    row("note", "non-EIP-1559: bounds clamp tx.gasprice for fee→gas", onBounds.maxGasPriceWei > 0n);
  }

  section("Price oracle");
  let oracleOk = false;
  const configOracle = (chainCfg.priceOracle || chainCfg.oracle?.consumers?.inbox || "") as string;
  row("inbox.priceOracle", priceOracleAddr === zeroAddress ? "(unset)" : priceOracleAddr, priceOracleAddr !== zeroAddress);
  row("deployConfig.priceOracle", configOracle || "(unset)");
  if (priceOracleAddr !== zeroAddress) {
    const wired =
      isAddr(configOracle) && priceOracleAddr.toLowerCase() === configOracle.toLowerCase();
    row("matches deployConfig", String(wired), wired || !isAddr(configOracle));
    try {
      const oracle = await getContract(clients, "PriceOracle", priceOracleAddr);
      const [localUsd, remoteUsd] = await oracle.read.getPricesUSD();
      let localTok = zeroAddress as Address;
      let remoteTok = zeroAddress as Address;
      try {
        localTok = (await oracle.read.localToken()) as Address;
        remoteTok = (await oracle.read.remoteToken()) as Address;
      } catch {
        // plain PriceOracle may expose getters differently
      }
      row("getPricesUSD local", usd18(localUsd), localUsd > 0n);
      row("getPricesUSD remote", usd18(remoteUsd), remoteUsd > 0n);
      row("inbox tokens", `local=${localTok} remote=${remoteTok}`);
      oracleOk = localUsd > 0n && remoteUsd > 0n;
      try {
        const live = await getContract(clients, "PoDPriceOracle", priceOracleAddr);
        const interval = await live.read.fetchInterval();
        const last = await live.read.lastFetchTimestamp();
        row("fetchInterval", `${interval}s`);
        row("lastFetchTimestamp", String(last));
      } catch {
        row("oracle type", "PriceOracle (plain / no live interval)");
      }
    } catch (err) {
      row("oracle read failed", err instanceof Error ? err.message : String(err), false);
    }
  }

  if (role === "source") {
    section("MpcAdder");
    const adderAddr = chainCfg.mpcAdder;
    if (!isAddr(adderAddr)) {
      row("mpcAdder", "(not deployed)", false);
    } else {
      const adder = await getContract(clients, "MpcAdder", adderAddr);
      const [adderInbox, mpcExecutor, cotiChainId] = await Promise.all([
        adder.read.inbox() as Promise<Address>,
        adder.read.mpcExecutor() as Promise<Address>,
        adder.read.cotiChainId() as Promise<bigint>,
      ]);
      row("address", adderAddr, true);
      row("inbox()", adderInbox, adderInbox.toLowerCase() === inboxAddr.toLowerCase());
      row("mpcExecutor()", mpcExecutor === zeroAddress ? "(unset)" : mpcExecutor, mpcExecutor !== zeroAddress);
      row("cotiChainId()", String(cotiChainId), Number(cotiChainId) === COTI_TESTNET_CHAIN_ID);
    }
  } else {
    section("MpcExecutor");
    const execAddr = chainCfg.cotiExecutor;
    row("cotiExecutor", isAddr(execAddr) ? execAddr : "(not deployed)", isAddr(execAddr));
  }

  return { inbox, oracleOk, feesOk, boundsOk };
};

const runAddRoundTrip = async (params: {
  source: ChainClients;
  coti: ChainClients;
  sourceCfg: Record<string, any>;
  cotiCfg: Record<string, any>;
  a: bigint;
  b: bigint;
}): Promise<void> => {
  const { source, coti, sourceCfg, cotiCfg, a, b } = params;
  hr(`MpcAdder.add round-trip: ${source.label} ↔ COTI`);

  const sourceInboxAddr = sourceCfg.inbox as Address;
  const cotiInboxAddr = cotiCfg.inbox as Address;
  const adderAddr = sourceCfg.mpcAdder as Address;
  const executorAddr = cotiCfg.cotiExecutor as Address;

  if (!isAddr(sourceInboxAddr) || !isAddr(cotiInboxAddr) || !isAddr(adderAddr) || !isAddr(executorAddr)) {
    throw new Error(
      `Missing addresses for ${source.label} round-trip ` +
        `(need source inbox+mpcAdder and COTI inbox+cotiExecutor in deployConfig).`
    );
  }

  const sourceInbox = await getContract(source, "Inbox", sourceInboxAddr);
  const cotiInbox = await getContract(coti, "Inbox", cotiInboxAddr);
  const adder = await getContract(source, "MpcAdder", adderAddr);

  const mpcExecutor = (await adder.read.mpcExecutor()) as Address;
  if (mpcExecutor.toLowerCase() !== executorAddr.toLowerCase()) {
    throw new Error(
      `MpcAdder.mpcExecutor ${mpcExecutor} != deployConfig cotiExecutor ${executorAddr}. Run ConfigureAdder.`
    );
  }

  // Onboard encrypt wallet against live COTI AccountOnboard.
  const cotiPk =
    optionalEnv("COTI_TESTNET_PRIVATE_KEY")?.trim() ||
    optionalEnv("PRIVATE_KEY")?.trim() ||
    "";
  if (!cotiPk) throw new Error("Set COTI_TESTNET_PRIVATE_KEY or PRIVATE_KEY for encryption onboard.");
  const cotiRpc =
    optionalEnv("COTI_TESTNET_RPC_URL")?.trim() ||
    (coti.publicClient.chain?.rpcUrls?.default?.http?.[0] as string | undefined) ||
    resolveRpcUrl(COTI_TESTNET_CHAIN_ID);
  const onboardAddress = process.env.COTI_ONBOARD_CONTRACT_ADDRESS || ONBOARD_CONTRACT_ADDRESS;
  console.log(`  onboarding AES key via ${onboardAddress} on ${cotiRpc}…`);
  const userKey = await onboardUser(cotiPk, cotiRpc, onboardAddress);
  const cotiProvider = new JsonRpcProvider(cotiRpc) as any;
  const cotiEncryptWallet = new CotiWallet(cotiPk.startsWith("0x") ? cotiPk : `0x${cotiPk}`, cotiProvider);
  cotiEncryptWallet.setAesKey(userKey);

  const encryptCtx = {
    crypto: { userKey, cotiEncryptWallet },
    contracts: { inboxCoti: cotiInbox },
  };

  section(`Encrypt + send add(${a}, ${b})`);
  const itA = await buildEncryptedInput(encryptCtx as any, a);
  const itB = await buildEncryptedInput(encryptCtx as any, b);
  const fees = await estimateGas(sourceInbox);
  row("fee estimate totalWei", formatEther(fees.totalValueWei));
  row("fee estimate callbackWei", formatEther(fees.callbackFeeWei));

  const writeOpts = podTwoWayWriteOptions(fees);
  // Live testnets: let the node estimate gas (Hardhat pad is oversized for EIP-1559).
  const liveOpts = { value: writeOpts.value, account: source.walletClient.account };
  console.log(`  sending MpcAdder.add value=${formatEther(liveOpts.value)} ETH…`);
  const txHash = await adder.write.add([itA, itB, fees.callbackFeeWei], liveOpts);
  await source.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
  row("source tx", txHash, true);

  const outbound = await getLatestRequest(sourceInbox, BigInt(COTI_TESTNET_CHAIN_ID));
  row("outbound requestId", outbound.requestId);
  row("targetContract", outbound.targetContract, outbound.targetContract.toLowerCase() === executorAddr.toLowerCase());
  row("isTwoWay", String(outbound.isTwoWay), outbound.isTwoWay);
  row("targetFee (gas units)", String(outbound.targetFee));
  row("callerFee (gas units)", String(outbound.callerFee));
  row(
    "callbackSelector",
    outbound.callbackSelector,
    outbound.callbackSelector === toFunctionSelector("receiveC(bytes)")
  );

  section("Mine COTI leg (source → COTI)");
  await mineInbound({
    label: `${source.label}->COTI`,
    inbox: cotiInbox,
    publicClient: coti.publicClient,
    walletClient: coti.walletClient,
    sourceChainId: BigInt(source.chainId),
    request: outbound,
    chainLabel: "COTI",
  });

  const err = await cotiInbox.read.errors([outbound.requestId]);
  const errId = getTupleField(err, "requestId", 0);
  if (errId && errId !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    throw new Error(
      `COTI execution error for ${outbound.requestId}: code=${getTupleField(err, "errorCode", 1)} msg=${getTupleField(err, "errorMessage", 2)}`
    );
  }

  const responseRequest = await getResponseRequestBySource(cotiInbox, outbound.requestId, `${source.label}->COTI`);
  row("response requestId", responseRequest.requestId);
  row("response target", responseRequest.targetContract, responseRequest.targetContract.toLowerCase() === adderAddr.toLowerCase());

  section(`Mine ${source.label} callback (COTI → source)`);
  await mineInbound({
    label: `COTI->${source.label}`,
    inbox: sourceInbox,
    publicClient: source.publicClient,
    walletClient: source.walletClient,
    sourceChainId: BigInt(COTI_TESTNET_CHAIN_ID),
    request: responseRequest,
    chainLabel: source.label,
  });

  const sourceOutbound = parseRequest(await sourceInbox.read.requests([outbound.requestId]));
  row("original executed", String(sourceOutbound.executed), sourceOutbound.executed);

  section("Decrypt result");
  const encryptedResult = await adder.read.resultCiphertext();
  const decrypted = decryptUint(decodeCtUint64(encryptedResult), userKey);
  row("ciphertext", String(decodeCtUint64(encryptedResult)));
  row("decrypted", String(decrypted), decrypted === a + b);
  row("expected a+b", String(a + b));
  if (decrypted !== a + b) {
    throw new Error(`Decrypt mismatch: got ${decrypted}, expected ${a + b}`);
  }
  console.log(`  ✓ ${source.label} ↔ COTI add round-trip OK (${a}+${b}=${decrypted})`);
};

const main = async () => {
  const cfg = await readDeployConfig();
  const cotiCfg = (cfg.chains?.[String(COTI_TESTNET_CHAIN_ID)] ?? {}) as Record<string, any>;

  console.log("PoD deployment verification");
  console.log(`  deployConfig inboxSalt.label = ${cfg.inboxSalt?.label ?? "(none)"}`);
  console.log(`  deterministic inbox address  = ${cfg.inboxSalt?.address || "(empty)"}`);
  if (cfg.inboxSalt?.bytecodeNote) console.log(`  note: ${cfg.inboxSalt.bytecodeNote}`);
  if (cfg.inboxSalt?.runbook) console.log(`  runbook: ${cfg.inboxSalt.runbook}`);
  console.log(`  mode: ${CONFIG_ONLY ? "config-only (no add round-trips)" : "config + MpcAdder.add round-trips"}`);

  const coti = await connectNetwork("cotiTestnet", "COTI Testnet");
  const cotiStatus = await printChainConfig(coti, cotiCfg, "coti");

  const results: { chain: string; configOk: boolean; roundTrip?: "ok" | "skipped" | "failed"; error?: string }[] = [];

  for (const net of SOURCE_NETWORKS) {
    if (CHAIN_FILTER && !CHAIN_FILTER.has(net.name.toLowerCase()) && !CHAIN_FILTER.has(String(net.chainId))) {
      continue;
    }
    const chainCfg = (cfg.chains?.[String(net.chainId)] ?? {}) as Record<string, any>;
    if (!isAddr(chainCfg.inbox)) {
      console.log(`\n· skipping ${net.label}: no inbox in deployConfig`);
      continue;
    }

    const source = await connectNetwork(net.name, net.label);
    const status = await printChainConfig(source, chainCfg, "source");
    const configOk = !!(status.oracleOk && status.feesOk && status.boundsOk);

    if (CONFIG_ONLY || !isAddr(chainCfg.mpcAdder)) {
      results.push({
        chain: net.label,
        configOk,
        roundTrip: !isAddr(chainCfg.mpcAdder) ? "skipped" : "skipped",
      });
      if (!isAddr(chainCfg.mpcAdder)) {
        console.log(`\n· no mpcAdder for ${net.label}; skipping add round-trip`);
      }
      continue;
    }

    try {
      // Distinct plaintext per chain so ciphertext/results are obviously different in logs.
      const a = net.chainId === 43113 ? 21n : 12n;
      const b = net.chainId === 43113 ? 34n : 30n;
      await runAddRoundTrip({
        source,
        coti,
        sourceCfg: chainCfg,
        cotiCfg,
        a,
        b,
      });
      results.push({ chain: net.label, configOk, roundTrip: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n✗ ${net.label} round-trip failed: ${message}`);
      results.push({ chain: net.label, configOk, roundTrip: "failed", error: message });
    }
  }

  hr("Summary");
  row("COTI oracle legs", cotiStatus.oracleOk ? "ok" : "check", cotiStatus.oracleOk);
  row("COTI fee templates", cotiStatus.feesOk ? "match config" : "drift", cotiStatus.feesOk);
  row("COTI gas bounds", cotiStatus.boundsOk ? "match config" : "drift", cotiStatus.boundsOk);
  for (const r of results) {
    const rt =
      r.roundTrip === "ok" ? "add OK" : r.roundTrip === "failed" ? `add FAILED (${r.error})` : "add skipped";
    row(r.chain, `config ${r.configOk ? "ok" : "drift"} · ${rt}`, r.roundTrip !== "failed" && r.configOk);
  }

  const failed = results.some((r) => r.roundTrip === "failed");
  const configDrift = !cotiStatus.oracleOk || !cotiStatus.feesOk || !cotiStatus.boundsOk || results.some((r) => !r.configOk);
  if (failed) process.exitCode = 1;
  else if (configDrift) {
    console.log("\n(config drift noted; exit 0 — fix fees/bounds/oracle wiring if intentional)");
  } else {
    console.log("\nAll checks passed.");
  }
};

main().catch((err) => {
  console.error("\n[verify-deployments] fatal:", err);
  process.exitCode = 1;
});
