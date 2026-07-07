import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { network } from "hardhat";
import type { Address, PublicClient, WalletClient } from "viem";
import { encodeFunctionData, zeroAddress } from "viem";
import {
  INBOX_SALT_LABEL,
  buildInboxSalt,
  computeGuardedSalt,
  precomputeCreate3Address,
} from "./createx.js";
import {
  asAddress,
  chainlinkFeedsForChain,
  configureTestnetInboxMinFees,
  createPublicClientForChain,
  deployDeterministicInbox,
  deployOracleForChain,
  ensureMinerRegistered,
  getViemClients,
  oracleConfigFromChain,
  oracleAdapterType,
  recordOracleDeploy,
  resolveConsumerOracle,
  resolvePortalOracle,
  optionalEnv,
  podConfigureKeepInbox,
  patchBuildInfoSolcLongVersion,
  readFeeConfigForChain,
  oracleTokensForChain,
  resolveDeployerAddress,
  resolveWalletAccount,
  usePlainOracleForConfig,
  waitMined,
  wireOracleToFactory,
  wireOracleToInbox,
  COTI_ADMIN_WRITE_GAS,
  ensureGasFunds,
} from "./deploy-utils.js";
import {
  explorerAddressUrl,
  hasOnChainCode,
  isVerifiedOnExplorer,
} from "./explorer.js";
import {
  CIRCLE_USDC_FAUCET,
  FUJI_AVAX_FAUCET,
  canonicalUnderlying,
} from "./privacyPortal/canonical-collateral.js";

const deployConfigPath = path.resolve(process.cwd(), "deployConfig.json");

// --- CLI flags ---
// Parsed from argv (the `deploy:cli` npm script launches this file directly via tsx, so flags
// pass straight through to process.argv). Env fallbacks keep scripted/CI use simple.
//   --noverify    skip explorer verification after a deploy
//   --verify-all  verify every deployed contract on the connected network, then exit
const CLI_FLAGS = process.argv.slice(2);
const truthyEnv = (key: string): boolean => /^(1|true|yes|on)$/i.test(optionalEnv(key) ?? "");
const NO_VERIFY = CLI_FLAGS.includes("--noverify") || truthyEnv("DEPLOY_CLI_NOVERIFY");
const VERIFY_ALL = CLI_FLAGS.includes("--verify-all") || truthyEnv("DEPLOY_CLI_VERIFY_ALL");

type Role = "source" | "coti";

/** User-selectable networks (must exist in hardhat.config.ts). */
const DEPLOY_NETWORKS: { name: string; chainId: number; role: Role; label: string }[] = [
  { name: "sepolia", chainId: 11155111, role: "source", label: "Sepolia" },
  { name: "avalancheFuji", chainId: 43113, role: "source", label: "Avalanche Fuji" },
  { name: "cotiTestnet", chainId: 7082400, role: "coti", label: "COTI Testnet" },
];

type DeployCtx = {
  viem: any;
  publicClient: PublicClient;
  walletClient: WalletClient;
  chainId: number;
  networkName: string;
  deployer: Address;
  /** Deterministic CreateX address for the Inbox (known before deploy). */
  inboxAddress: Address;
  /** Salt label driving the deterministic Inbox address family (from deployConfig or default). */
  inboxSaltLabel: string;
};

type Target = {
  id: string;
  label: string;
  /** Roles (network kinds) this target applies to. */
  roles: Role[];
  /** Target ids that must be deployed before this one is selectable. */
  dependsOn: string[];
  /**
   * `contract`: deploys + verifies an address-bearing contract.
   * `action`: applies on-chain configuration (no address, no verify).
   */
  kind: "contract" | "action";

  // --- contract-only ---
  contractName?: string;
  /** Key under `deployConfig.chains[chainId]` where the address is stored. */
  configKey?: string;
  /** Recorded/precomputed address (may exist before on-chain deploy). */
  resolveAddress?: (ctx: DeployCtx, chainCfg: Record<string, any>) => Address | undefined;
  /** Deploy (and wire) the contract; returns the deployed address. */
  deploy?: (ctx: DeployCtx) => Promise<Address>;
  /** Constructor args (as strings) passed to `hardhat verify`. */
  verifyArgs?: (ctx: DeployCtx) => string[];

  // --- action-only ---
  /** Report whether on-chain state already matches the desired config. */
  status?: (ctx: DeployCtx) => Promise<{ applied: boolean; detail?: string }>;
  /** Apply the action (idempotent). */
  run?: (ctx: DeployCtx) => Promise<void>;
};

// --- deployConfig.json helpers (flexible shape; preserves unknown keys) ---

const readCfg = async (): Promise<any> => JSON.parse(await fs.readFile(deployConfigPath, "utf8"));
/** Synchronous read used by `verifyArgs` (which must return constructor args synchronously). */
const readCfgSync = (): any => JSON.parse(readFileSync(deployConfigPath, "utf8"));
const writeCfg = async (cfg: any): Promise<void> =>
  fs.writeFile(deployConfigPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
const chainEntry = (cfg: any, chainId: number): Record<string, any> => {
  cfg.chains ??= {};
  cfg.chains[String(chainId)] ??= {};
  return cfg.chains[String(chainId)];
};
const chainCfgSync = (chainId: number): Record<string, any> =>
  readCfgSync().chains?.[String(chainId)] ?? {};

/** Salt label that drives the deterministic Inbox address family (chain-independent). */
const readInboxSaltLabel = (cfg: any): string => {
  const label = cfg?.inboxSalt?.label;
  return typeof label === "string" && label.length > 0 ? label : INBOX_SALT_LABEL;
};

/**
 * Persist the resolved Inbox salt back to `deployConfig.inboxSalt` so the deterministic
 * inputs are transparent and editable. The 32-byte `salt`/`guardedSalt`/`address` are
 * deployer-specific; `label` is the deployer-independent knob that selects the address family.
 */
const recordInboxSalt = async (params: {
  label: string;
  deployer: Address;
  salt: `0x${string}`;
  guardedSalt: `0x${string}`;
  address: Address;
}): Promise<void> => {
  const cfg = await readCfg();
  cfg.inboxSalt = {
    label: params.label,
    deployer: params.deployer,
    salt: params.salt,
    guardedSalt: params.guardedSalt,
    address: params.address,
  };
  await writeCfg(cfg);
};

/** Factory owner for PrivacyPortal deployments: `FACTORY_OWNER` env if set, else the deployer. */
const factoryOwner = (ctx: DeployCtx): Address => {
  const raw = optionalEnv("FACTORY_OWNER");
  return raw ? asAddress(raw, "FACTORY_OWNER") : ctx.deployer;
};

const getInbox = (ctx: DeployCtx) =>
  ctx.viem.getContractAt("Inbox", ctx.inboxAddress, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });

const deploySimple = async (ctx: DeployCtx, name: string, args: unknown[]): Promise<Address> => {
  const c = await ctx.viem.deployContract(name, args, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  return c.address as Address;
};

// --- source-side Pod app COTI routing (MpcAdder -> COTI MpcExecutor) ---

const COTI_TESTNET_CHAIN_ID = 7082400n;
const COTI_MAINNET_CHAIN_ID = 2632500n;

/** COTI chain id a given source chain pairs with (mainnet -> COTI mainnet, otherwise COTI testnet). */
const pairedCotiChainId = (ctx: DeployCtx): bigint =>
  ctx.chainId === 1 ? COTI_MAINNET_CHAIN_ID : COTI_TESTNET_CHAIN_ID;

/** Resolve the COTI chain id this source chain pairs with and its recorded MPC executor address. */
const resolveCotiExecutor = async (
  ctx: DeployCtx
): Promise<{ cotiChainId: bigint; executor?: Address }> => {
  const cotiChainId = ctx.chainId === 1 ? COTI_MAINNET_CHAIN_ID : COTI_TESTNET_CHAIN_ID;
  const cfg = await readCfg();
  const raw: unknown = cfg.chains?.[String(cotiChainId)]?.cotiExecutor;
  const executor =
    typeof raw === "string" && raw.startsWith("0x") && raw.length === 42 ? (raw as Address) : undefined;
  return { cotiChainId, executor };
};

/**
 * Point an already-deployed MpcAdder at the COTI MPC executor (owner-gated `configure`, keeps inbox).
 * Idempotent. Returns false (with a warning) when the executor isn't recorded yet so the caller can
 * preserve the deployed address and let the user re-run the ConfigureAdder action later.
 */
const configureMpcAdder = async (ctx: DeployCtx, adderAddress: Address): Promise<boolean> => {
  const { cotiChainId, executor } = await resolveCotiExecutor(ctx);
  if (!executor) {
    console.warn(
      `  COTI executor not set in deployConfig.chains.${cotiChainId}.cotiExecutor; ` +
        `deploy MpcExecutor on COTI first, then run the ConfigureAdder action.`
    );
    return false;
  }
  const adder = await ctx.viem.getContractAt("MpcAdder", adderAddress, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  const deployer = await resolveDeployerAddress(ctx.walletClient);
  const hash = await adder.write.configure(podConfigureKeepInbox(executor, cotiChainId), {
    account: deployer,
  });
  await waitMined(ctx.publicClient, hash);
  console.log(`  configured MpcAdder -> executor ${executor} (cotiChainId ${cotiChainId})`);
  return true;
};

// --- fee config (read on-chain templates to compare against deployConfig.json) ---

const FEE_FIELDS = [
  "constantFee",
  "gasPerByte",
  "callbackExecutionGas",
  "errorLength",
  "bufferRatioX10000",
] as const;
type FeeTuple = Record<(typeof FEE_FIELDS)[number], bigint>;

/** Normalize the inbox `FeeConfig` getter result (viem returns an array for multi-field struct getters). */
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

const readInboxFeeConfigs = async (inbox: any): Promise<[FeeTuple, FeeTuple]> => {
  const [local, remote] = await Promise.all([
    inbox.read.localMinFeeConfig(),
    inbox.read.remoteMinFeeConfig(),
  ]);
  return [normalizeFee(local), normalizeFee(remote)];
};

const feeEq = (a: FeeTuple, b: Record<string, bigint>): boolean =>
  FEE_FIELDS.every((f) => a[f] === b[f]);

const feeIsZero = (a: FeeTuple): boolean => FEE_FIELDS.every((f) => a[f] === 0n);

// --- PrivacyPortal test-token wiring ---

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** True for a syntactically valid, non-zero address string. */
const isAddr = (v: unknown): v is Address =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && v.toLowerCase() !== ZERO_ADDRESS;

/**
 * Registry of PrivacyPortal tokens. Static params live here; deployed portal/pToken
 * addresses are recorded in deployConfig (data-driven).
 *
 * All source pTokens share one COTI-side mother ledger:
 *   chains[<coti>].cotiMother
 *   chains[<source>].privacyPortalTokens[key] = { underlying, portal, pToken }
 *
 * Native ETH (Sepolia) / AVAX (Fuji): underlying is WETH/WAVAX. Users wrap before
 * deposit and unwrap after withdraw in the app layer; the portal only sees ERC-20.
 */
type PpUnderlyingKind = "mock" | "canonical";

type PpToken = {
  key: string;
  pName: string;
  pSymbol: string;
  decimals: number;
  underlyingKind: PpUnderlyingKind;
  /** Menu label for the underlying setup target. */
  underlyingLabel: string;
  /** Mock only: deploy `MockERC20Decimals` with this name/symbol. */
  underlyingName?: string;
  underlyingSymbol?: string;
  /**
   * Canonical only: key into {@link CANONICAL_UNDERLYING}[chainId], e.g. `USDC`, `WETH`, `WAVAX`.
   * May differ per source chain (WETH on Sepolia, WAVAX on Fuji).
   */
  canonicalKey?: string;
  sources: number[];
};

/** Short labels for chains used in menu target names. */
const SOURCE_LABEL: Record<number, string> = {
  1: "Eth",
  11155111: "Sep",
  43113: "Avax",
};
const srcLabel = (chainId: number): string => SOURCE_LABEL[chainId] ?? String(chainId);

const PP_TOKENS: PpToken[] = [
  {
    key: "pMTT",
    pName: "Private MyTestToken",
    pSymbol: "pMTT",
    decimals: 18,
    underlyingKind: "mock",
    underlyingLabel: "MTT ERC20",
    underlyingName: "MyTestToken",
    underlyingSymbol: "MTT",
    sources: [11155111, 43113],
  },
  {
    key: "pUSDC",
    pName: "Private USDC",
    pSymbol: "pUSDC",
    decimals: 6,
    underlyingKind: "canonical",
    underlyingLabel: "USDC",
    canonicalKey: "USDC",
    sources: [11155111, 43113],
  },
  {
    key: "pWETH",
    pName: "Private WETH",
    pSymbol: "pWETH",
    decimals: 18,
    underlyingKind: "canonical",
    underlyingLabel: "WETH (wrap ETH)",
    canonicalKey: "WETH",
    sources: [11155111],
  },
  {
    key: "pWAVAX",
    pName: "Private WAVAX",
    pSymbol: "pWAVAX",
    decimals: 18,
    underlyingKind: "canonical",
    underlyingLabel: "WAVAX (wrap AVAX)",
    canonicalKey: "WAVAX",
    sources: [43113],
  },
];

const resolveCanonicalUnderlying = (t: PpToken, chainId: number): Address | undefined => {
  if (t.underlyingKind !== "canonical" || !t.canonicalKey) return undefined;
  const addr = canonicalUnderlying(chainId, t.canonicalKey);
  return addr && isAddr(addr) ? addr : undefined;
};

const logCanonicalCollateralHints = (t: PpToken, chainId: number, underlying: Address) => {
  if (t.canonicalKey === "USDC") {
    console.log(`  ${t.key}: Circle USDC — get test tokens at ${CIRCLE_USDC_FAUCET}`);
  }
  if (t.canonicalKey === "WETH") {
    console.log(`  ${t.key}: deposit via portal.depositNative() — msg.value = amount + mintFee (wraps in-contract)`);
  }
  if (t.canonicalKey === "WAVAX") {
    console.log(`  ${t.key}: deposit via portal.depositNative() — msg.value = amount + mintFee (wraps in-contract)`);
    console.log(`  ${t.key}: Fuji AVAX gas faucet: ${FUJI_AVAX_FAUCET}`);
  }
};

/** COTI chain a given source chain pairs with (mainnet -> COTI mainnet, otherwise COTI testnet). */
const cotiChainForSource = (sourceChainId: number): number =>
  sourceChainId === 1 ? Number(COTI_MAINNET_CHAIN_ID) : Number(COTI_TESTNET_CHAIN_ID);

/** Source-side token entry `{ underlying?, portal?, pToken? }` from deployConfig. */
const readSourceToken = (sourceChainId: number, key: string): Record<string, any> =>
  readCfgSync().chains?.[String(sourceChainId)]?.privacyPortalTokens?.[key] ?? {};

/** COTI mother contract address from deployConfig. */
const readCotiMother = (cotiChainId: number | bigint): string | undefined =>
  readCfgSync().chains?.[String(cotiChainId)]?.cotiMother;

/** Persist a field on the source-side token entry under `chains[source].privacyPortalTokens[key]`. */
const recordSourceTokenField = async (
  sourceChainId: number,
  key: string,
  field: string,
  value: string
): Promise<void> => {
  const cfg = await readCfg();
  const entry = chainEntry(cfg, sourceChainId);
  entry.privacyPortalTokens ??= {};
  entry.privacyPortalTokens[key] ??= {};
  entry.privacyPortalTokens[key][field] = value;
  await writeCfg(cfg);
};

/**
 * Build PrivacyPortal wiring targets for every token in `PP_TOKENS`:
 *   - Source side (per token): an underlying (mock collateral) target and a portal target, each
 *     operating on whichever of the token's source chains is currently connected.
 */
const buildPpTokenTargets = (): Target[] => {
  const targets: Target[] = [];

  for (const t of PP_TOKENS) {
    targets.push({
      id: `ppUnderlying:${t.key}`,
      label: t.underlyingLabel,
      kind: "action",
      roles: ["source"],
      dependsOn: [],
      status: async (ctx) => {
        if (!t.sources.includes(ctx.chainId)) return { applied: false, detail: "n/a on this chain" };
        const recorded = readSourceToken(ctx.chainId, t.key).underlying;
        if (isAddr(recorded)) {
          return { applied: true, detail: recorded };
        }
        if (t.underlyingKind === "canonical") {
          const expected = resolveCanonicalUnderlying(t, ctx.chainId);
          if (!expected) return { applied: false, detail: `no canonical ${t.canonicalKey} on chain` };
          const deployed = await hasOnChainCode(ctx.publicClient, expected);
          return deployed
            ? { applied: false, detail: `ready ${expected}` }
            : { applied: false, detail: `${expected} (no code)` };
        }
        return { applied: false, detail: "not deployed (mock)" };
      },
      run: async (ctx) => {
        if (!t.sources.includes(ctx.chainId)) {
          throw new Error(`Chain ${ctx.chainId} is not a configured source for ${t.key}.`);
        }
        const existing = readSourceToken(ctx.chainId, t.key).underlying;
        if (isAddr(existing)) {
          console.log(`  ${t.key} underlying already set: ${existing}`);
          return;
        }

        if (t.underlyingKind === "canonical") {
          const addr = resolveCanonicalUnderlying(t, ctx.chainId);
          if (!addr) {
            throw new Error(`${t.key}: canonical ${t.canonicalKey} not configured for chain ${ctx.chainId}`);
          }
          if (!(await hasOnChainCode(ctx.publicClient, addr))) {
            throw new Error(`${t.key}: no contract code at canonical underlying ${addr}`);
          }
          await recordSourceTokenField(ctx.chainId, t.key, "underlying", addr);
          console.log(`  ${t.key} underlying (${t.canonicalKey}, ${t.decimals}d): ${addr}`);
          logCanonicalCollateralHints(t, ctx.chainId, addr);
          console.log(`  Recorded deployConfig.chains.${ctx.chainId}.privacyPortalTokens.${t.key}.underlying`);
          return;
        }

        const addr = await deploySimple(ctx, "MockERC20Decimals", [
          t.underlyingName!,
          t.underlyingSymbol!,
          t.decimals,
        ]);
        const token = await ctx.viem.getContractAt("MockERC20Decimals", addr, {
          client: { public: ctx.publicClient, wallet: ctx.walletClient },
        });
        const mintAmount = 1_000_000n * 10n ** BigInt(t.decimals);
        const mintHash = await token.write.mint([ctx.deployer, mintAmount], { account: ctx.deployer });
        await waitMined(ctx.publicClient, mintHash);
        await recordSourceTokenField(ctx.chainId, t.key, "underlying", addr);
        console.log(`  ${t.key} underlying (${t.underlyingSymbol}, ${t.decimals}d) deployed: ${addr}`);
        console.log(`  Minted 1,000,000 ${t.underlyingSymbol} to ${ctx.deployer}`);
        console.log(`  Recorded deployConfig.chains.${ctx.chainId}.privacyPortalTokens.${t.key}.underlying`);
      },
    });

    targets.push({
      id: `ppPortal:${t.key}`,
      label: `${t.pSymbol} portal`,
      kind: "action",
      roles: ["source"],
      dependsOn: ["ppPortalFactory"],
      status: async (ctx) => {
        if (!t.sources.includes(ctx.chainId)) return { applied: false, detail: "n/a on this chain" };
        const entry = readSourceToken(ctx.chainId, t.key);
        const cotiMother = readCotiMother(pairedCotiChainId(ctx));
        if (!isAddr(cotiMother)) return { applied: false, detail: "needs COTI mother" };
        if (!isAddr(entry.underlying)) return { applied: false, detail: `set ${t.underlyingLabel} first` };
        if (!isAddr(entry.portal) || !isAddr(entry.pToken)) {
          return { applied: false, detail: "ready to create" };
        }
        const cotiPublicClient = createPublicClientForChain(Number(pairedCotiChainId(ctx)));
        const mother = await ctx.viem.getContractAt("PodErc20CotiMother", cotiMother as Address, {
          client: { public: cotiPublicClient, wallet: ctx.walletClient },
        });
        const registered = await mother.read.isRegistered([BigInt(ctx.chainId), entry.pToken]);
        return registered
          ? { applied: true, detail: `portal ${entry.portal}` }
          : { applied: false, detail: "awaiting mother registration" };
      },
      run: async (ctx) => {
        if (!t.sources.includes(ctx.chainId)) {
          throw new Error(`Chain ${ctx.chainId} is not a configured source for ${t.key}.`);
        }
        const entry = readSourceToken(ctx.chainId, t.key);
        const underlying = asAddress(
          entry.underlying,
          `chains.${ctx.chainId}.privacyPortalTokens.${t.key}.underlying`
        );
        const factoryAddr = asAddress(chainCfgSync(ctx.chainId).privacyPortalFactory, "privacyPortalFactory");
        const factory = await ctx.viem.getContractAt("PrivacyPortalFactory", factoryAddr, {
          client: { public: ctx.publicClient, wallet: ctx.walletClient },
        });

        let portal = (await factory.read.portalForUnderlying([underlying])) as Address;
        let pToken = (await factory.read.pTokenForUnderlying([underlying])) as Address;
        if (!isAddr(portal)) {
          const hash = await factory.write.createPortal(
            [
              underlying,
              t.pName,
              t.pSymbol,
              t.decimals,
              t.canonicalKey === "WETH" || t.canonicalKey === "WAVAX",
              factoryOwner(ctx),
            ],
            { account: ctx.deployer, value: 1_000_000_000_000_000n }
          );
          await waitMined(ctx.publicClient, hash);
          portal = (await factory.read.portalForUnderlying([underlying])) as Address;
          pToken = (await factory.read.pTokenForUnderlying([underlying])) as Address;
          console.log(`  ${t.key} registration requested on COTI mother for pToken=${pToken}`);
        } else {
          console.log(`  ${t.key} portal already exists at factory: ${portal}`);
        }

        await recordSourceTokenField(ctx.chainId, t.key, "portal", portal);
        await recordSourceTokenField(ctx.chainId, t.key, "pToken", pToken);
        console.log(`  ${t.key} (${srcLabel(ctx.chainId)}) portal=${portal} pToken=${pToken}`);
        console.log(`  Recorded deployConfig.chains.${ctx.chainId}.privacyPortalTokens.${t.key}`);
      },
    });
  }

  return targets;
};

// --- Target registry ---

const TARGETS: Target[] = [
  {
    id: "inbox",
    label: "Inbox",
    kind: "contract",
    contractName: "Inbox",
    roles: ["source", "coti"],
    dependsOn: [],
    configKey: "inbox",
    resolveAddress: (ctx) => ctx.inboxAddress,
    deploy: async (ctx) => {
      const { inbox, alreadyDeployed } = await deployDeterministicInbox({
        viem: ctx.viem,
        publicClient: ctx.publicClient,
        walletClient: ctx.walletClient,
        saltLabel: ctx.inboxSaltLabel,
      });
      const minerRaw = optionalEnv("MINER_ADDRESS");
      if (minerRaw) {
        const added = await ensureMinerRegistered({
          inbox,
          miner: asAddress(minerRaw, "MINER_ADDRESS"),
          publicClient: ctx.publicClient,
          walletClient: ctx.walletClient,
        });
        console.log(added ? "  miner registered" : "  miner already registered");
      } else {
        console.log("  MINER_ADDRESS not set; skipped addMiner");
      }
      if (alreadyDeployed) console.log("  (inbox already existed at deterministic address)");
      return inbox.address as Address;
    },
    verifyArgs: () => [],
  },
  {
    id: "priceOracle",
    label: "PriceOracle",
    kind: "contract",
    contractName: "PoDPriceOracle",
    roles: ["source", "coti"],
    dependsOn: [],
    configKey: "priceOracle",
    resolveAddress: (_ctx, chainCfg) => chainCfg.priceOracle || undefined,
    deploy: async (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      const oracleConfig = oracleConfigFromChain(chainCfg);
      const { address, contractName, liveAdapter } = await deployOracleForChain({
        viem: ctx.viem,
        publicClient: ctx.publicClient,
        walletClient: ctx.walletClient,
        chainId: ctx.chainId,
        oracleConfig,
      });
      const cfg = await readCfg();
      const entry = chainEntry(cfg, ctx.chainId);
      recordOracleDeploy(entry, {
        priceOracle: address,
        liveAdapter,
        adapter: oracleAdapterType(oracleConfig),
      });
      await writeCfg(cfg);
      console.log(`  deployed ${contractName} at ${address}`);
      if (liveAdapter) {
        console.log(`  live adapter (${oracleAdapterType(oracleConfig)}) at ${liveAdapter}`);
      }
      console.log("  run WireInboxOracle / WireFactoryOracle to point consumers at the oracle(s)");
      console.log(
        "  optional: set oracle.consumers.inbox / oracle.consumers.privacyPortalFactory to use different addresses"
      );
      return address;
    },
    verifyArgs: (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      const oracleConfig = oracleConfigFromChain(chainCfg);
      if (usePlainOracleForConfig(oracleConfig)) {
        return [ctx.deployer];
      }
      const feeds = chainlinkFeedsForChain(ctx.chainId);
      const liveAdapter = (chainCfg.oracle?.liveAdapter?.trim() || zeroAddress) as Address;
      const fetchInterval =
        oracleConfig.fetchInterval != null && String(oracleConfig.fetchInterval).trim() !== ""
          ? String(oracleConfig.fetchInterval)
          : feeds.fetchIntervalSeconds.toString();
      return [ctx.deployer, liveAdapter, fetchInterval];
    },
  },
  {
    id: "wireInboxOracle",
    label: "WireInboxOracle",
    kind: "action",
    roles: ["source", "coti"],
    dependsOn: ["inbox"],
    status: async (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      const oracleAddr = resolveConsumerOracle(chainCfg, "inbox");
      if (!oracleAddr || !isAddr(oracleAddr)) return { applied: false, detail: "no inbox oracle in deployConfig" };
      if (!(await hasOnChainCode(ctx.publicClient, oracleAddr))) {
        return { applied: false, detail: "oracle address has no code" };
      }
      const inbox = await getInbox(ctx);
      const current = (await inbox.read.priceOracle()) as Address;
      if (current.toLowerCase() === oracleAddr.toLowerCase()) {
        return { applied: true, detail: String(oracleAddr) };
      }
      return { applied: false, detail: `inbox=${current} config=${oracleAddr}` };
    },
    run: async (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      const oracleAddr = asAddress(resolveConsumerOracle(chainCfg, "inbox")!, "inbox oracle");
      const inbox = await getInbox(ctx);
      await wireOracleToInbox({
        inbox,
        oracleAddress: oracleAddr,
        publicClient: ctx.publicClient,
        walletClient: ctx.walletClient,
      });
      console.log(`  inbox wired to oracle ${oracleAddr}`);
    },
  },
  {
    id: "wireFactoryOracle",
    label: "WireFactoryOracle",
    kind: "action",
    roles: ["source"],
    dependsOn: ["ppPortalFactory"],
    status: async (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      const oracleAddr = resolveConsumerOracle(chainCfg, "privacyPortalFactory");
      const factoryAddr = chainCfg.privacyPortalFactory;
      if (!oracleAddr || !isAddr(oracleAddr)) return { applied: false, detail: "no portal oracle in deployConfig" };
      if (!(await hasOnChainCode(ctx.publicClient, oracleAddr))) {
        return { applied: false, detail: "portal oracle address has no code" };
      }
      if (!isAddr(factoryAddr)) return { applied: false, detail: "no privacyPortalFactory in deployConfig" };
      const factory = await ctx.viem.getContractAt("PrivacyPortalFactory", factoryAddr as Address, {
        client: { public: ctx.publicClient, wallet: ctx.walletClient },
      });
      const current = (await factory.read.priceOracle()) as Address;
      if (current.toLowerCase() === oracleAddr.toLowerCase()) {
        return { applied: true, detail: String(oracleAddr) };
      }
      return { applied: false, detail: `factory=${current} config=${oracleAddr}` };
    },
    run: async (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      const oracleAddr = asAddress(resolveConsumerOracle(chainCfg, "privacyPortalFactory")!, "portal oracle");
      const factoryAddr = asAddress(chainCfg.privacyPortalFactory, "privacyPortalFactory");
      await wireOracleToFactory({
        viem: ctx.viem,
        factoryAddress: factoryAddr,
        oracleAddress: oracleAddr,
        publicClient: ctx.publicClient,
        walletClient: ctx.walletClient,
      });
      console.log(`  factory wired to oracle ${oracleAddr}`);
    },
  },
  {
    id: "feeConfig",
    label: "FeeConfig",
    kind: "action",
    roles: ["source", "coti"],
    dependsOn: ["inbox"],
    status: async (ctx) => {
      const inbox = await getInbox(ctx);
      const [curLocal, curRemote] = await readInboxFeeConfigs(inbox);
      const { local, remote } = await readFeeConfigForChain(ctx.chainId);
      if (feeEq(curLocal, local) && feeEq(curRemote, remote)) {
        return { applied: true, detail: "matches config" };
      }
      const isSet = !feeIsZero(curLocal) || !feeIsZero(curRemote);
      return { applied: false, detail: isSet ? "differs from config" : "not set" };
    },
    run: async (ctx) => {
      const inbox = await getInbox(ctx);
      await configureTestnetInboxMinFees({
        inbox,
        publicClient: ctx.publicClient,
        walletClient: ctx.walletClient,
        chainId: ctx.chainId,
      });
    },
  },
  {
    id: "mpcExecutor",
    label: "MpcExecutor",
    kind: "contract",
    contractName: "MpcExecutor",
    roles: ["coti"],
    dependsOn: ["inbox"],
    configKey: "cotiExecutor",
    resolveAddress: (_ctx, chainCfg) => chainCfg.cotiExecutor || undefined,
    deploy: (ctx) => deploySimple(ctx, "MpcExecutor", [ctx.inboxAddress]),
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },
  {
    id: "pErc20Coti",
    label: "PErc20Coti",
    kind: "contract",
    contractName: "PErc20Coti",
    roles: ["coti"],
    dependsOn: ["inbox"],
    configKey: "pErc20Coti",
    resolveAddress: (_ctx, chainCfg) => chainCfg.pErc20Coti || undefined,
    deploy: (ctx) => deploySimple(ctx, "PErc20Coti", [ctx.inboxAddress]),
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },
  {
    id: "mpcAdder",
    label: "MpcAdder",
    kind: "contract",
    contractName: "MpcAdder",
    roles: ["source"],
    dependsOn: ["inbox"],
    configKey: "mpcAdder",
    resolveAddress: (_ctx, chainCfg) => chainCfg.mpcAdder || undefined,
    deploy: async (ctx) => {
      const address = await deploySimple(ctx, "MpcAdder", [ctx.inboxAddress]);
      await configureMpcAdder(ctx, address);
      return address;
    },
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },
  {
    id: "configureAdder",
    label: "ConfigureAdder",
    kind: "action",
    roles: ["source"],
    dependsOn: ["mpcAdder"],
    status: async (ctx) => {
      const { cotiChainId, executor } = await resolveCotiExecutor(ctx);
      if (!executor) return { applied: false, detail: `needs COTI executor (chain ${cotiChainId})` };
      // `mpcExecutorAddress` is internal on-chain (no getter), so we can't confirm the current
      // value — surface the intended target and let the user (re-)apply on demand.
      return { applied: false, detail: `ready -> ${executor}` };
    },
    run: async (ctx) => {
      const cfg = await readCfg();
      const adderAddr: unknown = cfg.chains?.[String(ctx.chainId)]?.mpcAdder;
      if (typeof adderAddr !== "string" || !adderAddr) {
        throw new Error(`MpcAdder not recorded for chain ${ctx.chainId}; deploy it first.`);
      }
      const ok = await configureMpcAdder(ctx, adderAddr as Address);
      if (!ok) throw new Error("COTI executor address missing; cannot configure MpcAdder.");
    },
  },
  {
    id: "pErc20",
    label: "PErc20",
    kind: "contract",
    contractName: "PErc20",
    roles: ["source"],
    dependsOn: ["inbox"],
    configKey: "pErc20",
    resolveAddress: (_ctx, chainCfg) => chainCfg.pErc20 || undefined,
    deploy: (ctx) => deploySimple(ctx, "PErc20", [ctx.inboxAddress]),
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },
  {
    id: "millionaire",
    label: "Millionaire",
    kind: "contract",
    contractName: "Millionaire",
    roles: ["source"],
    dependsOn: ["inbox"],
    configKey: "millionaire",
    resolveAddress: (_ctx, chainCfg) => chainCfg.millionaire || undefined,
    deploy: (ctx) => deploySimple(ctx, "Millionaire", [ctx.inboxAddress]),
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },

  // --- PrivacyPortal: COTI side (unified mother ledger) ---
  {
    id: "ppCotiMother",
    label: "PpCotiMother",
    kind: "contract",
    contractName: "PodErc20CotiMother",
    roles: ["coti"],
    dependsOn: ["inbox"],
    configKey: "cotiMother",
    resolveAddress: (_ctx, chainCfg) => chainCfg.cotiMother || undefined,
    deploy: (ctx) => deploySimple(ctx, "PodErc20CotiMother", [ctx.inboxAddress, factoryOwner(ctx)]),
    verifyArgs: (ctx) => [ctx.inboxAddress, factoryOwner(ctx)],
  },
  {
    id: "ppCotiMotherAllowlist",
    label: "PpMotherAllow",
    kind: "action",
    roles: ["coti"],
    dependsOn: ["ppCotiMother"],
    status: async (ctx) => {
      const motherAddr = chainCfgSync(ctx.chainId).cotiMother;
      if (!isAddr(motherAddr)) return { applied: false, detail: "needs COTI mother" };
      const mother = await ctx.viem.getContractAt("PodErc20CotiMother", motherAddr as Address, {
        client: { public: ctx.publicClient, wallet: ctx.walletClient },
      });
      const motherOwner = (await mother.read.owner()) as Address;
      let canSign = false;
      let balanceNote = "";
      try {
        await resolveWalletAccount(ctx.walletClient, motherOwner);
        canSign = true;
        const balance = await ctx.publicClient.getBalance({ address: motherOwner });
        if (balance < 500_000_000_000_000n) {
          balanceNote = ` · low COTI balance (${balance} wei)`;
        }
      } catch {
        canSign = false;
      }
      const missing: string[] = [];
      for (const net of DEPLOY_NETWORKS.filter((n) => n.role === "source")) {
        const factory = chainCfgSync(net.chainId).privacyPortalFactory;
        if (!isAddr(factory)) continue;
        const allowed = await mother.read.allowedFactories([BigInt(net.chainId), factory]);
        if (!allowed) missing.push(`${net.label}`);
      }
      if (missing.length === 0) {
        return { applied: true, detail: "all factories allowlisted" };
      }
      if (!canSign) {
        return {
          applied: false,
          detail: `missing: ${missing.join(", ")} · need owner ${motherOwner} in wallet`,
        };
      }
      return { applied: false, detail: `missing: ${missing.join(", ")}${balanceNote}` };
    },
    run: async (ctx) => {
      const motherAddr = asAddress(chainCfgSync(ctx.chainId).cotiMother, "cotiMother");
      const mother = await ctx.viem.getContractAt("PodErc20CotiMother", motherAddr, {
        client: { public: ctx.publicClient, wallet: ctx.walletClient },
      });
      const motherOwner = (await mother.read.owner()) as Address;
      const signer = await resolveWalletAccount(ctx.walletClient, motherOwner);
      if (signer.toLowerCase() !== ctx.deployer.toLowerCase()) {
        console.log(`  using mother owner ${signer} (deployer ${ctx.deployer} is not owner)`);
      }
      for (const net of DEPLOY_NETWORKS.filter((n) => n.role === "source")) {
        const factory = chainCfgSync(net.chainId).privacyPortalFactory;
        if (!isAddr(factory)) {
          console.log(`  skip ${net.label}: no privacyPortalFactory in deployConfig`);
          continue;
        }
        const allowed = await mother.read.allowedFactories([BigInt(net.chainId), factory]);
        if (allowed) {
          console.log(`  ${net.label} factory already allowlisted: ${factory}`);
          continue;
        }
        const hash = await mother.write.setAllowedFactory([BigInt(net.chainId), factory, true], {
          account: signer,
          gas: await ensureGasFunds({
            publicClient: ctx.publicClient,
            account: signer,
            to: motherAddr,
            data: encodeFunctionData({
              abi: mother.abi,
              functionName: "setAllowedFactory",
              args: [BigInt(net.chainId), factory, true],
            }),
            label: `mother owner ${signer}`,
          }),
        });
        await waitMined(ctx.publicClient, hash);
        console.log(`  allowlisted ${net.label} factory=${factory}`);
      }
    },
  },

  // --- PrivacyPortal: source side (clone implementations + factory) ---
  {
    id: "ppPortalImpl",
    label: "PpPortalImpl",
    kind: "contract",
    contractName: "PrivacyPortal",
    roles: ["source"],
    dependsOn: [],
    configKey: "portalImplementation",
    resolveAddress: (_ctx, chainCfg) => chainCfg.portalImplementation || undefined,
    deploy: (ctx) => deploySimple(ctx, "PrivacyPortal", []),
    verifyArgs: () => [],
  },
  {
    id: "ppTokenImpl",
    label: "PpTokenImpl",
    kind: "contract",
    contractName: "PodErc20MintableInitializable",
    roles: ["source"],
    dependsOn: [],
    configKey: "podTokenImplementation",
    resolveAddress: (_ctx, chainCfg) => chainCfg.podTokenImplementation || undefined,
    deploy: (ctx) => deploySimple(ctx, "PodErc20MintableInitializable", []),
    verifyArgs: () => [],
  },
  {
    id: "ppPortalFactory",
    label: "PpFactory",
    kind: "contract",
    contractName: "PrivacyPortalFactory",
    roles: ["source"],
    dependsOn: ["inbox", "ppPortalImpl", "ppTokenImpl"],
    configKey: "privacyPortalFactory",
    resolveAddress: (_ctx, chainCfg) => chainCfg.privacyPortalFactory || undefined,
    deploy: async (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      const portalImpl = asAddress(chainCfg.portalImplementation, "portalImplementation");
      const podTokenImpl = asAddress(chainCfg.podTokenImplementation, "podTokenImplementation");
      const cotiMother = asAddress(
        readCotiMother(pairedCotiChainId(ctx)),
        `chains.${pairedCotiChainId(ctx)}.cotiMother`
      );
      const portalOracle = resolvePortalOracle(chainCfg);
      const oracleAddr = portalOracle && isAddr(portalOracle) ? (portalOracle as Address) : zeroAddress;
      if (oracleAddr === zeroAddress) {
        console.log("  no portal oracle in config — factory deploys with zero; run WireFactoryOracle after PriceOracle");
      } else {
        console.log(`  factory constructor oracle: ${oracleAddr}`);
      }
      const maxFee = (1n << 128n) - 1n;
      const owner = factoryOwner(ctx);
      const { portalNative } = oracleTokensForChain(ctx.chainId);
      return deploySimple(ctx, "PrivacyPortalFactory", [
        owner,
        ctx.inboxAddress,
        pairedCotiChainId(ctx),
        cotiMother,
        podTokenImpl,
        portalImpl,
        owner,
        portalNative,
        oracleAddr,
        0n,
        0n,
        maxFee,
        0n,
        0n,
        maxFee,
      ]);
    },
    verifyArgs: (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      const owner = factoryOwner(ctx);
      const maxFee = ((1n << 128n) - 1n).toString();
      const portalOracle = resolvePortalOracle(chainCfg) ?? zeroAddress;
      return [
        owner,
        ctx.inboxAddress,
        String(pairedCotiChainId(ctx)),
        readCotiMother(pairedCotiChainId(ctx)) ?? "",
        chainCfg.podTokenImplementation,
        chainCfg.portalImplementation,
        owner,
        oracleTokensForChain(ctx.chainId).portalNative,
        portalOracle,
        "0",
        "0",
        maxFee,
        "0",
        "0",
        maxFee,
      ];
    },
  },

  // --- PrivacyPortal test-token wiring (per token, per source chain; clones via the factories) ---
  ...buildPpTokenTargets(),
];

// --- Status computation ---

type TargetStatus = {
  target: Target;
  // contract fields (deployed=false for actions)
  address?: Address;
  deployed: boolean;
  verified?: boolean;
  // action fields
  applied?: boolean;
  detail?: string;
  blockedBy: string[];
};

const gatherStatuses = async (ctx: DeployCtx, role: Role): Promise<TargetStatus[]> => {
  const cfg = await readCfg();
  const chainCfg = chainEntry(cfg, ctx.chainId);
  const applicable = TARGETS.filter((t) => t.roles.includes(role));
  const order = new Map(applicable.map((t, i) => [t.id, i]));

  // 1) contracts: address + on-chain code
  const contracts = applicable.filter((t) => t.kind === "contract");
  const base = await Promise.all(
    contracts.map(async (target) => {
      const address = target.resolveAddress!(ctx, chainCfg);
      const deployed = address ? await hasOnChainCode(ctx.publicClient, address) : false;
      return { target, address, deployed };
    })
  );
  const deployedById = new Map(base.map((b) => [b.target.id, b.deployed]));

  // 2) verification (only for deployed) in parallel
  const verified = await Promise.all(
    base.map((b) => (b.deployed && b.address ? isVerifiedOnExplorer(ctx.chainId, b.address) : Promise.resolve(undefined)))
  );
  const contractStatuses: TargetStatus[] = base.map((b, i) => ({
    target: b.target,
    address: b.address,
    deployed: b.deployed,
    verified: verified[i],
    blockedBy: b.target.dependsOn.filter((dep) => !deployedById.get(dep)),
  }));

  // 3) actions: gated on contract deps; read on-chain state when unblocked
  const actions = applicable.filter((t) => t.kind === "action");
  const actionStatuses: TargetStatus[] = await Promise.all(
    actions.map(async (target) => {
      const blockedBy = target.dependsOn.filter((dep) => !deployedById.get(dep));
      if (blockedBy.length) return { target, deployed: false, applied: false, blockedBy };
      try {
        const { applied, detail } = await target.status!(ctx);
        return { target, deployed: false, applied, detail, blockedBy };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { target, deployed: false, applied: false, detail: `status error: ${msg}`, blockedBy };
      }
    })
  );

  return [...contractStatuses, ...actionStatuses].sort(
    (a, b) => order.get(a.target.id)! - order.get(b.target.id)!
  );
};

const renderStatusLabel = (s: TargetStatus): string => {
  const name = s.target.label.padEnd(13);
  if (s.target.kind === "action") {
    const blocked = s.blockedBy.length ? `  (needs: ${s.blockedBy.join(", ")})` : "";
    let state: string;
    if (s.blockedBy.length) state = "blocked";
    else if (s.applied) state = `configured${s.detail ? ` (${s.detail})` : ""}`;
    else state = s.detail ?? "not configured";
    return `${name} [${state}]${blocked}`;
  }
  let state: string;
  if (!s.deployed) state = "not deployed";
  else if (s.verified === true) state = "deployed, verified";
  else if (s.verified === false) state = "deployed, UNVERIFIED";
  else state = "deployed, verify?";
  const addr = s.address ? `  ${s.address}` : "";
  // Only surface a dependency block when the target still needs deploying.
  const blocked = !s.deployed && s.blockedBy.length ? `  (needs: ${s.blockedBy.join(", ")})` : "";
  return `${name} [${state}]${addr}${blocked}`;
};

// --- Interactive keyboard menu ---

type MenuItem<T> = { value: T; label: string; disabled?: boolean };

const interactiveSelect = async <T>(title: string, items: MenuItem<T>[]): Promise<T | undefined> => {
  if (!process.stdin.isTTY) {
    console.log(`\n${title}`);
    items.forEach((it, i) => console.log(`  ${i + 1}. ${it.label}${it.disabled ? "  [blocked]" : ""}`));
    console.log("(non-interactive terminal: run in a TTY to select)\n");
    return undefined;
  }

  return new Promise<T | undefined>((resolve) => {
    let idx = items.findIndex((i) => !i.disabled);
    if (idx < 0) idx = 0;

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const render = () => {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      process.stdout.write(`${title}\n(\u2191/\u2193 move \u00b7 Enter select \u00b7 q quit)\n\n`);
      items.forEach((it, i) => {
        const pointer = i === idx ? "\u276f " : "  ";
        const dim = it.disabled ? "\x1b[2m" : "";
        const hi = i === idx && !it.disabled ? "\x1b[36m" : "";
        process.stdout.write(`${dim}${hi}${pointer}${it.label}\x1b[0m\n`);
      });
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("keypress", onKey);
      process.stdin.pause();
    };

    const move = (delta: number) => {
      let n = idx;
      for (let k = 0; k < items.length; k++) {
        n = (n + delta + items.length) % items.length;
        if (!items[n].disabled) {
          idx = n;
          break;
        }
      }
      render();
    };

    const onKey = (_str: string, key: readline.Key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") move(-1);
      else if (key.name === "down" || key.name === "j") move(1);
      else if (key.name === "return") {
        const chosen = items[idx];
        cleanup();
        process.stdout.write("\n");
        resolve(chosen && !chosen.disabled ? chosen.value : undefined);
      } else if (key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup();
        process.stdout.write("\n");
        resolve(undefined);
      }
    };

    process.stdin.on("keypress", onKey);
    render();
  });
};

const pressAnyKey = async (message = "Press any key to return to the menu..."): Promise<void> => {
  if (!process.stdin.isTTY) return;
  process.stdout.write(`\n${message}`);
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("keypress", onKey);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve();
    };
    process.stdin.on("keypress", onKey);
  });
};

// --- verify via hardhat CLI ---

const runHardhat = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["hardhat", ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`hardhat ${args.join(" ")} (exit ${code})`))));
  });

const verifyContract = async (networkName: string, address: Address, args: string[]) => {
  patchBuildInfoSolcLongVersion();
  console.log(`Verifying on explorer: ${address}${args.length ? ` args=[${args.join(", ")}]` : ""}`);
  await runHardhat(["verify", "--network", networkName, address, ...args]);
};

/**
 * Verify a deployed contract on the explorer unless `--noverify` is set or it's already verified.
 * Failures are non-fatal (logged) so a deploy run isn't lost to a flaky verifier.
 */
const maybeVerify = async (ctx: DeployCtx, target: Target, address: Address): Promise<void> => {
  if (NO_VERIFY) {
    console.log(`Skipping verification (--noverify): ${explorerAddressUrl(ctx.chainId, address) ?? address}`);
    return;
  }
  const verified = await isVerifiedOnExplorer(ctx.chainId, address);
  if (verified === true) {
    console.log(`Already verified: ${explorerAddressUrl(ctx.chainId, address) ?? address}`);
    return;
  }
  try {
    await verifyContract(ctx.networkName, address, target.verifyArgs!(ctx));
    console.log(`Verified: ${explorerAddressUrl(ctx.chainId, address) ?? address}`);
  } catch (error) {
    console.warn(`Verification failed (you can retry later):`, error instanceof Error ? error.message : error);
  }
};

// --- action: deploy (if needed) + verify (if needed) + persist ---

const runTarget = async (ctx: DeployCtx, s: TargetStatus): Promise<void> => {
  const { target } = s;

  if (target.kind === "action") {
    console.log(`\n=== Applying ${target.label} on ${ctx.networkName} ===`);
    await target.run!(ctx);
    console.log(`Applied ${target.label}.`);
    return;
  }

  let address = s.address;

  if (!s.deployed) {
    console.log(`\n=== Deploying ${target.label} on ${ctx.networkName} ===`);
    address = await target.deploy!(ctx);
    const cfg = await readCfg();
    chainEntry(cfg, ctx.chainId)[target.configKey!] = address;
    await writeCfg(cfg);
    console.log(`Deployed ${target.label}: ${address}`);
    console.log(`Recorded deployConfig.chains.${ctx.chainId}.${target.configKey}`);
  } else {
    console.log(`\n=== ${target.label} already deployed at ${address} ===`);
  }

  if (!address) return;

  await maybeVerify(ctx, target, address);
};

/**
 * `--verify-all`: walk every contract target applicable to the connected network, and verify
 * any that are deployed on-chain but not yet verified on the explorer. Already-verified
 * contracts are skipped. Verification failures are reported but don't abort the run.
 */
const runVerifyAll = async (ctx: DeployCtx, role: Role): Promise<void> => {
  console.log(`\n=== Verify-all on ${ctx.networkName} (chainId ${ctx.chainId}) ===`);
  const statuses = await gatherStatuses(ctx, role);
  const contracts = statuses.filter((s) => s.target.kind === "contract" && s.deployed && s.address);
  if (!contracts.length) {
    console.log("No deployed contracts found to verify.");
    return;
  }

  let verified = 0;
  let skipped = 0;
  let failed = 0;
  for (const s of contracts) {
    const address = s.address!;
    if (s.verified === true) {
      console.log(`= ${s.target.label.padEnd(13)} already verified  ${explorerAddressUrl(ctx.chainId, address) ?? address}`);
      skipped++;
      continue;
    }
    console.log(`\n--- Verifying ${s.target.label} (${address}) ---`);
    try {
      await verifyContract(ctx.networkName, address, s.target.verifyArgs!(ctx));
      console.log(`+ Verified ${s.target.label}: ${explorerAddressUrl(ctx.chainId, address) ?? address}`);
      verified++;
    } catch (error) {
      console.warn(`! Verification failed for ${s.target.label}:`, error instanceof Error ? error.message : error);
      failed++;
    }
  }
  console.log(
    `\nVerify-all done on ${ctx.networkName}: ${verified} verified, ${skipped} already verified, ${failed} failed (${contracts.length} contracts).`
  );
};

const main = async () => {
  // Optional non-interactive network selection (handy for status checks / CI):
  // `DEPLOY_CLI_NETWORK=avalancheFuji npm run deploy:cli`.
  const envNet = optionalEnv("DEPLOY_CLI_NETWORK");
  let net: (typeof DEPLOY_NETWORKS)[number] | undefined;
  if (envNet) {
    net = DEPLOY_NETWORKS.find((n) => n.name === envNet);
    if (!net) {
      console.error(`Unknown DEPLOY_CLI_NETWORK="${envNet}". Known: ${DEPLOY_NETWORKS.map((n) => n.name).join(", ")}`);
      return;
    }
  } else {
    net = await interactiveSelect(
      "Select a network to deploy to",
      DEPLOY_NETWORKS.map((n) => ({ value: n, label: `${n.label.padEnd(16)} chainId ${n.chainId}  [${n.role}]` }))
    );
  }
  if (!net) {
    console.log("No network selected. Exiting.");
    return;
  }

  console.log(`Connecting to ${net.name}...`);
  const connection = await network.connect({ network: net.name });
  const { viem, provider, networkName } = connection;
  const { chainId, publicClient, walletClient } = await getViemClients(viem, provider, networkName);
  const deployer = await resolveDeployerAddress(walletClient);
  const inboxSaltLabel = readInboxSaltLabel(await readCfg());
  const inboxSalt = buildInboxSalt(deployer, inboxSaltLabel);
  const inboxAddress = await precomputeCreate3Address(publicClient, deployer, inboxSalt);
  // Keep deployConfig.inboxSalt in sync with the resolved deterministic inputs.
  await recordInboxSalt({
    label: inboxSaltLabel,
    deployer,
    salt: inboxSalt,
    guardedSalt: computeGuardedSalt(deployer, inboxSalt),
    address: inboxAddress,
  });

  const ctx: DeployCtx = {
    viem,
    publicClient,
    walletClient,
    chainId,
    networkName,
    deployer,
    inboxAddress,
    inboxSaltLabel,
  };

  // `--verify-all`: verify every deployed-but-unverified contract on this network, then exit.
  if (VERIFY_ALL) {
    await runVerifyAll(ctx, net.role);
    return;
  }

  // Non-interactive batch mode: `DEPLOY_CLI_NETWORK=<net> DEPLOY_CLI_TARGETS=id1,id2 npm run deploy:cli`.
  // Runs the listed target ids in order (re-reading status between each so dependency gating and
  // freshly recorded addresses stay accurate). Useful for scripted/CI deploys.
  const targetsEnv = optionalEnv("DEPLOY_CLI_TARGETS");
  if (targetsEnv) {
    const ids = targetsEnv.split(",").map((s) => s.trim()).filter(Boolean);
    console.log(`Batch mode on ${net.label} (chainId ${chainId}) -> ${ids.join(", ")}`);
    for (const id of ids) {
      const statuses = await gatherStatuses(ctx, net.role);
      const s = statuses.find((st) => st.target.id === id);
      if (!s) {
        console.error(`  Unknown target "${id}" for role "${net.role}"; skipping.`);
        continue;
      }
      if (s.blockedBy.length) {
        console.error(`  Target "${id}" blocked by: ${s.blockedBy.join(", ")}; skipping.`);
        continue;
      }
      await runTarget(ctx, s);
    }
    console.log("Batch mode done.");
    return;
  }

  // Main interactive loop: recompute status each pass so dependency gating stays accurate.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log("Reading deployment status (chain + explorer)...");
    const statuses = await gatherStatuses(ctx, net.role);
    const items: MenuItem<TargetStatus | "exit">[] = statuses.map((s) => ({
      value: s,
      // Actions are gated purely by deps; contracts stay selectable once deployed
      // (so they can be re-verified) but are blocked while deps are missing.
      disabled:
        s.target.kind === "action"
          ? s.blockedBy.length > 0
          : !s.deployed && s.blockedBy.length > 0,
      label: renderStatusLabel(s),
    }));
    items.push({ value: "exit", label: "Exit" });

    const title =
      `Deploy menu \u2014 ${net.label} (chainId ${chainId})\n` +
      `deployer ${deployer} \u00b7 inbox(det) ${inboxAddress}\n` +
      `inbox salt label "${inboxSaltLabel}"` +
      (NO_VERIFY ? `\nverification: OFF (--noverify)` : "");
    const choice = await interactiveSelect(title, items);
    if (!choice || choice === "exit") {
      console.log("Done.");
      break;
    }
    await runTarget(ctx, choice);
    await pressAnyKey();
  }
};

main().catch((error) => {
  console.error("[deploy-cli] Failed:", error);
  process.exitCode = 1;
});
