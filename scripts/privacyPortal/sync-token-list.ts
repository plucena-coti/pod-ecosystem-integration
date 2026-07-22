import fs from "node:fs/promises";
import path from "node:path";
import { zeroAddress } from "viem";
import {
  allowlistFactoryOnMother,
  connectPrivacyPortalNetwork,
  createSourcePortalAndPToken,
  DEFAULT_COTI_NETWORK,
  DEFAULT_SOURCE_NETWORK,
  deployCotiMother,
  deploySourceFactory,
  getCotiMotherFromConfig,
  getInboxFromConfig,
  optionalEnvAddress,
  type ConnectedNetwork,
} from "./deploy-utils.js";
import { asAddress } from "../deploy-utils.js";

type AddressString = `0x${string}`;

type SourcePrivacyPortalConfig = {
  factory?: string;
  portalImplementation?: string;
  podTokenImplementation?: string;
  inbox?: string;
  cotiNetwork?: string;
  cotiChainId?: number;
  cotiMother?: string;
};

type CotiPrivacyPortalConfig = {
  cotiMother?: string;
  inbox?: string;
};

type TokenConfig = {
  erc20: string;
  name: string;
  symbol: string;
  decimals?: number;
  privacyPortal?: string;
  pToken?: string;
};

type NetworkConfig = {
  chainId?: number;
  privacyPortal: SourcePrivacyPortalConfig | CotiPrivacyPortalConfig;
  tokens?: TokenConfig[];
};

type PrivacyPortalConfig = {
  networks: Record<string, NetworkConfig>;
};

const configPath = path.resolve(process.cwd(), process.env.PRIVACY_PORTAL_CONFIG || "PrivacyPortalConfig.json");

const isAddressSet = (value: string | undefined): value is AddressString =>
  typeof value === "string" && value.startsWith("0x") && value.length === 42 && value.toLowerCase() !== zeroAddress;

const normalizeOptionalAddress = (value: string | undefined, key: string): AddressString | undefined =>
  isAddressSet(value) ? asAddress(value, key) : undefined;

const requireTokenAddress = (value: string, key: string): AddressString => {
  if (!isAddressSet(value)) {
    throw new Error(`Token config ${key} must be a non-zero address`);
  }
  return asAddress(value, key);
};

const readConfig = async (): Promise<PrivacyPortalConfig> => {
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw) as PrivacyPortalConfig;
};

const writeConfig = async (config: PrivacyPortalConfig) => {
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
};

const getNetworkConfig = (config: PrivacyPortalConfig, networkName: string): NetworkConfig => {
  const networkConfig = config.networks[networkName];
  if (!networkConfig) {
    throw new Error(`Missing PrivacyPortalConfig.networks.${networkName}`);
  }
  networkConfig.tokens ??= [];
  return networkConfig;
};

const configuredInboxOrDeployConfig = async (
  ctx: ConnectedNetwork,
  networkConfig: NetworkConfig,
  label: string
): Promise<AddressString> => {
  const configured = normalizeOptionalAddress(networkConfig.privacyPortal.inbox, `${label}.privacyPortal.inbox`);
  return configured ?? getInboxFromConfig(ctx, label);
};

const ensureCotiMother = async (ctx: ConnectedNetwork, cotiConfig: NetworkConfig): Promise<AddressString> => {
  const existing = normalizeOptionalAddress(
    (cotiConfig.privacyPortal as CotiPrivacyPortalConfig).cotiMother,
    "coti.privacyPortal.cotiMother"
  );
  if (existing) {
    console.log(`[privacyPortal:sync] COTI mother already configured: ${existing}`);
    return existing;
  }

  try {
    const fromDeployConfig = await getCotiMotherFromConfig(ctx);
    (cotiConfig.privacyPortal as CotiPrivacyPortalConfig).cotiMother = fromDeployConfig;
    return fromDeployConfig;
  } catch {
    const inbox = await configuredInboxOrDeployConfig(ctx, cotiConfig, "coti");
    const owner = optionalEnvAddress("FACTORY_OWNER");
    const deployed = await deployCotiMother(ctx, { inbox, owner });
    (cotiConfig.privacyPortal as CotiPrivacyPortalConfig).cotiMother = deployed.mother;
    cotiConfig.privacyPortal.inbox = inbox;
    return deployed.mother;
  }
};

const ensureSourceFactory = async (
  ctx: ConnectedNetwork,
  sourceConfig: NetworkConfig,
  cotiChainId: bigint,
  cotiMother: AddressString
): Promise<AddressString> => {
  const existing = normalizeOptionalAddress(sourceConfig.privacyPortal.factory, "source.privacyPortal.factory");
  if (existing) {
    console.log(`[privacyPortal:sync] source factory already configured: ${existing}`);
    return existing;
  }

  const inbox = await configuredInboxOrDeployConfig(ctx, sourceConfig, "source");
  const owner = optionalEnvAddress("FACTORY_OWNER");
  const deployed = await deploySourceFactory(ctx, { inbox, cotiChainId, cotiMother, owner });
  sourceConfig.privacyPortal.factory = deployed.factory;
  (sourceConfig.privacyPortal as SourcePrivacyPortalConfig).portalImplementation = deployed.portalImplementation;
  (sourceConfig.privacyPortal as SourcePrivacyPortalConfig).podTokenImplementation = deployed.podTokenImplementation;
  (sourceConfig.privacyPortal as SourcePrivacyPortalConfig).cotiMother = cotiMother;
  sourceConfig.privacyPortal.inbox = inbox;
  return deployed.factory;
};

const syncTokenWithSourceFactory = async (
  ctx: ConnectedNetwork,
  token: TokenConfig,
  sourceFactoryAddress: AddressString
) => {
  const erc20 = requireTokenAddress(token.erc20, `tokens.${token.symbol}.erc20`);
  const factory = await ctx.viem.getContractAt("PrivacyPortalFactory", sourceFactoryAddress, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  const onChainPortal = await factory.read.portalForUnderlying([erc20]);
  const onChainPToken = await factory.read.pTokenForUnderlying([erc20]);

  if (isAddressSet(onChainPortal)) {
    if (isAddressSet(token.privacyPortal) && token.privacyPortal.toLowerCase() !== onChainPortal.toLowerCase()) {
      throw new Error(
        `Config portal ${token.privacyPortal} disagrees with factory portal ${onChainPortal} for ${erc20}`
      );
    }
    token.privacyPortal = onChainPortal;
  }

  if (isAddressSet(onChainPToken)) {
    if (isAddressSet(token.pToken) && token.pToken.toLowerCase() !== onChainPToken.toLowerCase()) {
      throw new Error(`Config pToken ${token.pToken} disagrees with factory pToken ${onChainPToken} for ${erc20}`);
    }
    token.pToken = onChainPToken;
  }
};

const ensureSourcePortalPair = async (
  sourceCtx: ConnectedNetwork,
  cotiCtx: ConnectedNetwork,
  token: TokenConfig,
  sourceFactoryAddress: AddressString,
  cotiMother: AddressString
) => {
  await syncTokenWithSourceFactory(sourceCtx, token, sourceFactoryAddress);
  if (isAddressSet(token.privacyPortal) && isAddressSet(token.pToken)) {
    console.log(
      `[privacyPortal:sync] ${token.symbol}: source portal=${token.privacyPortal} pToken=${token.pToken}`
    );
    return;
  }
  const deployed = await createSourcePortalAndPToken(sourceCtx, {
    factory: sourceFactoryAddress,
    underlying: requireTokenAddress(token.erc20, `tokens.${token.symbol}.erc20`),
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals ?? 18,
    cotiCtx,
    cotiMother,
    cotiChainId: BigInt(cotiCtx.chainId),
  });
  token.privacyPortal = deployed.portal;
  token.pToken = deployed.pToken;
};

const ensureMotherRegistration = async (
  cotiCtx: ConnectedNetwork,
  token: TokenConfig,
  sourceChainId: bigint,
  cotiMother: AddressString
) => {
  const pToken = requireTokenAddress(token.pToken ?? "", `tokens.${token.symbol}.pToken`);
  const mother = await cotiCtx.viem.getContractAt("PodErc20CotiMother", cotiMother, {
    client: { public: cotiCtx.publicClient, wallet: cotiCtx.walletClient },
  });
  const registered = await mother.read.isRegistered([sourceChainId, pToken]);
  if (!registered) {
    throw new Error(`${token.symbol}: pToken not registered on COTI mother (${sourceChainId}, ${pToken})`);
  }
  console.log(`[privacyPortal:sync] ${token.symbol}: registered on COTI mother`);
};

const main = async () => {
  const config = await readConfig();
  const sourceNetwork = process.env.SOURCE_NETWORK || DEFAULT_SOURCE_NETWORK;
  const sourceConfig = getNetworkConfig(config, sourceNetwork);
  const cotiNetwork =
    process.env.COTI_NETWORK || (sourceConfig.privacyPortal as SourcePrivacyPortalConfig).cotiNetwork || DEFAULT_COTI_NETWORK;
  const cotiConfig = getNetworkConfig(config, cotiNetwork);

  console.log(`[privacyPortal:sync] config=${configPath}`);
  console.log(`[privacyPortal:sync] source=${sourceNetwork} coti=${cotiNetwork}`);

  const source = await connectPrivacyPortalNetwork(sourceNetwork);
  const coti = await connectPrivacyPortalNetwork(cotiNetwork);

  sourceConfig.chainId = source.chainId;
  cotiConfig.chainId = coti.chainId;

  const configuredCotiChainId = (sourceConfig.privacyPortal as SourcePrivacyPortalConfig).cotiChainId;
  const cotiChainId = BigInt(configuredCotiChainId ?? coti.chainId);
  const cotiMother = await ensureCotiMother(coti, cotiConfig);
  const sourceFactory = await ensureSourceFactory(source, sourceConfig, cotiChainId, cotiMother);

  await allowlistFactoryOnMother(coti, {
    mother: cotiMother,
    sourceChainId: BigInt(source.chainId),
    factory: sourceFactory,
  });

  const tokens = sourceConfig.tokens ?? [];
  for (const token of tokens) {
    console.log(`[privacyPortal:sync] syncing token ${token.symbol} (${token.erc20})`);
    await ensureSourcePortalPair(source, coti, token, sourceFactory, cotiMother);
    await ensureMotherRegistration(coti, token, BigInt(source.chainId), cotiMother);
  }

  await writeConfig(config);
  console.log(`[privacyPortal:sync] wrote ${configPath}`);
};

main().catch((error) => {
  console.error("[privacyPortal:sync] Failed:", error);
  process.exitCode = 1;
});
