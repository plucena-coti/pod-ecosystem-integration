import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  getChainConfig,
  getViemClients,
  optionalEnv,
  readDeployConfig,
  resolveDeployerAddress,
  resolvePortalOracle,
  resolveWalletAccount,
  waitMined,
  ensureGasFunds,
  oracleTokensForChain,
} from "../deploy-utils.js";
import { encodeFunctionData, zeroAddress } from "viem";

export type ConnectedNetwork = {
  viem: any;
  chainId: number;
  chainName: string;
  publicClient: any;
  walletClient: any;
  deployer: `0x${string}`;
};

export type SourceFactoryDeployment = {
  portalImplementation: `0x${string}`;
  podTokenImplementation: `0x${string}`;
  factory: `0x${string}`;
};

export type CotiMotherDeployment = {
  mother: `0x${string}`;
};

export type SourcePortalDeployment = {
  portal: `0x${string}`;
  pToken: `0x${string}`;
};

export const DEFAULT_SOURCE_NETWORK = "sepolia";
export const DEFAULT_COTI_NETWORK = "cotiTestnet";

export const connectPrivacyPortalNetwork = async (networkName?: string): Promise<ConnectedNetwork> => {
  const connection = await network.connect(networkName ? { network: networkName } : undefined);
  const { viem, provider, networkName: hardhatNetworkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    hardhatNetworkName
  );
  const deployer = await resolveDeployerAddress(walletClient);
  console.log(`[privacyPortal] connected network=${chainName} chainId=${chainId} deployer=${deployer}`);
  return { viem, chainId, chainName, publicClient, walletClient, deployer };
};

export const envAddress = (key: string): `0x${string}` => asAddress(process.env[key] ?? "", key);

export const optionalEnvAddress = (key: string): `0x${string}` | undefined => {
  const value = optionalEnv(key);
  return value ? asAddress(value, key) : undefined;
};

export const envBigInt = (key: string, fallback?: bigint): bigint => {
  const value = optionalEnv(key);
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return BigInt(value);
};

export const envString = (key: string, fallback?: string): string => {
  const value = optionalEnv(key);
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const getInboxFromConfig = async (ctx: ConnectedNetwork, label: string): Promise<`0x${string}`> => {
  const configured = optionalEnvAddress(`${label.toUpperCase()}_INBOX`) ?? optionalEnvAddress("INBOX");
  if (configured) return configured;

  const deployConfig = await readDeployConfig();
  const chainConfig = getChainConfig(deployConfig, ctx.chainId, label);
  return asAddress(chainConfig.inbox ?? "", `deployConfig.chains.${ctx.chainId}.inbox`);
};

export const getCotiMotherFromConfig = async (ctx: ConnectedNetwork): Promise<`0x${string}`> => {
  const configured = optionalEnvAddress("COTI_MOTHER");
  if (configured) return configured;

  const deployConfig = await readDeployConfig();
  const chainConfig = getChainConfig(deployConfig, ctx.chainId, "coti");
  return asAddress(chainConfig.cotiMother ?? "", `deployConfig.chains.${ctx.chainId}.cotiMother`);
};

export const deployCotiMother = async (
  ctx: ConnectedNetwork,
  params: { inbox: `0x${string}`; owner?: `0x${string}` }
): Promise<CotiMotherDeployment> => {
  const owner = params.owner ?? ctx.deployer;
  console.log("[privacyPortal] deploying PodErc20CotiMother...");
  const mother = await ctx.viem.deployContract("PodErc20CotiMother", [params.inbox, owner], {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(`[privacyPortal] PodErc20CotiMother=${mother.address}`);
  await logDeployment(ctx, "PodErc20CotiMother", mother.address);
  return { mother: mother.address };
};

export const allowlistFactoryOnMother = async (
  ctx: ConnectedNetwork,
  params: { mother: `0x${string}`; sourceChainId: bigint; factory: `0x${string}` }
) => {
  const mother = await ctx.viem.getContractAt("PodErc20CotiMother", params.mother, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  const allowed = await mother.read.allowedFactories([params.sourceChainId, params.factory]);
  if (allowed) {
    console.log(
      `[privacyPortal] factory already allowlisted on mother chain=${params.sourceChainId} factory=${params.factory}`
    );
    return;
  }
  console.log(
    `[privacyPortal] allowlisting factory on mother chain=${params.sourceChainId} factory=${params.factory}...`
  );
  const motherOwner = (await mother.read.owner()) as `0x${string}`;
  const signer = await resolveWalletAccount(ctx.walletClient, motherOwner);
  const hash = await mother.write.setAllowedFactory([params.sourceChainId, params.factory, true], {
    account: signer,
    gas: await ensureGasFunds({
      publicClient: ctx.publicClient,
      account: signer,
      to: params.mother,
      data: encodeFunctionData({
        abi: mother.abi,
        functionName: "setAllowedFactory",
        args: [params.sourceChainId, params.factory, true],
      }),
      label: `mother owner ${signer}`,
    }),
  });
  await waitMined(ctx.publicClient, hash);
  console.log("[privacyPortal] factory allowlisted on mother");
};

export const deploySourceFactory = async (
  ctx: ConnectedNetwork,
  params: {
    inbox: `0x${string}`;
    cotiChainId: bigint;
    cotiMother: `0x${string}`;
    owner?: `0x${string}`;
    feeRecipient?: `0x${string}`;
    priceOracle?: `0x${string}`;
    depositFixedFee?: bigint;
    depositPercentageBps?: bigint;
    depositMaxFee?: bigint;
    withdrawFixedFee?: bigint;
    withdrawPercentageBps?: bigint;
    withdrawMaxFee?: bigint;
  }
): Promise<SourceFactoryDeployment> => {
  const owner = params.owner ?? ctx.deployer;
  const feeRecipient = params.feeRecipient ?? owner;
  const maxFee = (1n << 128n) - 1n;
  const deployConfig = await readDeployConfig();
  const chainConfig = getChainConfig(deployConfig, ctx.chainId, "source");
  const priceOracle =
    params.priceOracle ??
    (resolvePortalOracle(chainConfig) as `0x${string}` | undefined);
  console.log("[privacyPortal] deploying PrivacyPortal implementation...");
  const portalImplementation = await ctx.viem.deployContract("PrivacyPortal", [], {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(`[privacyPortal] PrivacyPortal implementation=${portalImplementation.address}`);

  console.log("[privacyPortal] deploying PodErc20MintableInitializable implementation...");
  const podTokenImplementation = await ctx.viem.deployContract("PodErc20MintableInitializable", [], {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(`[privacyPortal] PodErc20MintableInitializable implementation=${podTokenImplementation.address}`);

  console.log("[privacyPortal] deploying PrivacyPortalFactory...");
  const { portalNative } = oracleTokensForChain(ctx.chainId);
  const factory = await ctx.viem.deployContract(
    "PrivacyPortalFactory",
    [
      owner,
      params.inbox,
      params.cotiChainId,
      params.cotiMother,
      podTokenImplementation.address,
      portalImplementation.address,
      feeRecipient,
      portalNative,
      params.priceOracle ?? priceOracle ?? zeroAddress,
      params.depositFixedFee ?? 0n,
      params.depositPercentageBps ?? 0n,
      params.depositMaxFee ?? maxFee,
      params.withdrawFixedFee ?? 0n,
      params.withdrawPercentageBps ?? 0n,
      params.withdrawMaxFee ?? maxFee,
    ],
    { client: { public: ctx.publicClient, wallet: ctx.walletClient } }
  );
  console.log(`[privacyPortal] PrivacyPortalFactory=${factory.address}`);

  await logDeployment(ctx, "PrivacyPortal", portalImplementation.address);
  await logDeployment(ctx, "PodErc20MintableInitializable", podTokenImplementation.address);
  await logDeployment(ctx, "PrivacyPortalFactory", factory.address);

  return {
    portalImplementation: portalImplementation.address,
    podTokenImplementation: podTokenImplementation.address,
    factory: factory.address,
  };
};

export const createSourcePortalAndPToken = async (
  ctx: ConnectedNetwork,
  params: {
    factory: `0x${string}`;
    underlying: `0x${string}`;
    name: string;
    symbol: string;
    decimals?: number;
    nativeWrappedUnderlying?: boolean;
    portalOwner?: `0x${string}`;
    cotiCtx?: ConnectedNetwork;
    cotiMother?: `0x${string}`;
    cotiChainId?: bigint;
  }
): Promise<SourcePortalDeployment> => {
  const portalOwner = params.portalOwner ?? ctx.deployer;
  const decimals = params.decimals ?? 18;
  const factory = await ctx.viem.getContractAt("PrivacyPortalFactory", params.factory, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });

  console.log(`[privacyPortal] creating portal pair underlying=${params.underlying}...`);
  const hash = await factory.write.createPortal(
    [params.underlying, params.name, params.symbol, decimals, params.nativeWrappedUnderlying ?? false, portalOwner],
    { account: ctx.deployer, value: 2_500_000_000_000n }
  );
  await waitMined(ctx.publicClient, hash);

  const portal = await factory.read.portalForUnderlying([params.underlying]);
  const pToken = await factory.read.pTokenForUnderlying([params.underlying]);
  console.log(`[privacyPortal] PrivacyPortal=${portal}`);
  console.log(`[privacyPortal] PoD pToken=${pToken}`);

  const portalContract = await ctx.viem.getContractAt("PrivacyPortal", portal, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  const [depositPortalFee] = await portalContract.read.estimateDepositFees([1n]);
  const [withdrawPortalFee] = await portalContract.read.estimateWithdrawFees([1n]);
  console.log(`[privacyPortal] estimateDepositPortalFee(1)=${depositPortalFee}`);
  console.log(`[privacyPortal] estimateWithdrawPortalFee(1)=${withdrawPortalFee}`);

  if (params.cotiMother && params.cotiCtx) {
    await waitForMotherRegistration({
      cotiCtx: params.cotiCtx,
      mother: params.cotiMother,
      sourceChainId: BigInt(ctx.chainId),
      pToken,
      timeoutMs: 120_000,
    });
  }

  await logDeployment(ctx, "PrivacyPortal", portal);
  await logDeployment(ctx, "PodErc20Mintable", pToken);
  return { portal, pToken };
};

export const waitForMotherRegistration = async (params: {
  cotiCtx: ConnectedNetwork;
  mother: `0x${string}`;
  sourceChainId: bigint;
  pToken: `0x${string}`;
  timeoutMs?: number;
  pollMs?: number;
}) => {
  const mother = await params.cotiCtx.viem.getContractAt("PodErc20CotiMother", params.mother, {
    client: { public: params.cotiCtx.publicClient, wallet: params.cotiCtx.walletClient },
  });
  const deadline = Date.now() + (params.timeoutMs ?? 120_000);
  const pollMs = params.pollMs ?? 3_000;

  while (Date.now() < deadline) {
    const registered = await mother.read.isRegistered([params.sourceChainId, params.pToken]);
    if (registered) {
      console.log(
        `[privacyPortal] pToken registered on mother chain=${params.sourceChainId} pToken=${params.pToken}`
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out waiting for mother registration chain=${params.sourceChainId} pToken=${params.pToken}`
  );
};

export const logDeployment = async (ctx: ConnectedNetwork, contract: string, address: `0x${string}`) => {
  await appendDeploymentLog({
    contract,
    address,
    chainId: ctx.chainId,
    network: ctx.chainName,
  });
};
