import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  configureTestnetInboxMinFees,
  configureInboxGasPriceBounds,
  deployAndWireTestnetPriceOracle,
  deployDeterministicInbox,
  ensureMinerRegistered,
  getChainConfig,
  getViemClients,
  podConfigureKeepInbox,
  readDeployConfig,
  requireEnv,
} from "./deploy-utils.js";

/** Source network (Hardhat network name). Defaults to Sepolia; set to `avalancheFuji` for the AVAX<->COTI pair. */
const SOURCE_NETWORK = process.env.SOURCE_NETWORK ?? "sepolia";
const COTI_NETWORK = process.env.COTI_NETWORK ?? "cotiTestnet";
const ONLY_MPC_ADDER = process.env.ONLY_MPC_ADDER === "true";
const deployConfigPath = path.resolve(process.cwd(), "deployConfig.json");

const runHardhat = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["hardhat", ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Hardhat command failed: ${args.join(" ")}`));
      }
    });
  });

const verifyContract = async (
  networkName: string,
  contract: string,
  address: `0x${string}`,
  constructorArgs: string[]
) => {
  console.log(`[deploy-full-testnet] Verifying ${contract} on ${networkName}...`);
  try {
    await runHardhat(["verify", "--network", networkName, address, ...constructorArgs]);
    console.log(`[deploy-full-testnet] Verified ${contract} on ${networkName}`);
  } catch (error) {
    console.warn(
      `[deploy-full-testnet] Verification failed for ${contract} on ${networkName}:`,
      error
    );
  }
};

const main = async () => {
  const minerAddress = asAddress(requireEnv("MINER_ADDRESS"), "MINER_ADDRESS");
  console.log(`[deploy-full-testnet] Using miner: ${minerAddress}`);

  console.log(`[deploy-full-testnet] Connecting to source network ${SOURCE_NETWORK}`);
  const sourceConnection = await network.connect({ network: SOURCE_NETWORK });
  const { viem: sourceViem, provider: sourceProvider, networkName: sourceNetworkLabel } =
    sourceConnection;
  const {
    chainId: sourceChainId,
    chainName: sourceChainLabel,
    publicClient: sourcePublicClient,
    walletClient: sourceWalletClient,
  } = await getViemClients(sourceViem, sourceProvider, sourceNetworkLabel);
  console.log(
    `[deploy-full-testnet] Source connected: chainId=${sourceChainId} network=${sourceChainLabel}`
  );

  console.log(`[deploy-full-testnet] Connecting to COTI network ${COTI_NETWORK}`);
  const cotiConnection = await network.connect({ network: COTI_NETWORK });
  const { viem: cotiViem, provider: cotiProvider, networkName: cotiNetworkLabel } =
    cotiConnection;
  const {
    chainId: cotiChainIdNumber,
    chainName: cotiChainLabel,
    publicClient: cotiPublicClient,
    walletClient: cotiWalletClient,
  } = await getViemClients(cotiViem, cotiProvider, cotiNetworkLabel);
  const cotiChainId = BigInt(cotiChainIdNumber);
  console.log(
    `[deploy-full-testnet] COTI connected: chainId=${cotiChainIdNumber} network=${cotiChainLabel}`
  );

  console.log("[deploy-full-testnet] Deploying deterministic source Inbox via CreateX...");
  const sourceInboxDeploy = await deployDeterministicInbox({
    viem: sourceViem,
    publicClient: sourcePublicClient,
    walletClient: sourceWalletClient,
  });
  const sourceInbox = sourceInboxDeploy.inbox;
  console.log(
    sourceInboxDeploy.alreadyDeployed
      ? `[deploy-full-testnet] Source Inbox already deployed: ${sourceInbox.address}`
      : `[deploy-full-testnet] Source Inbox deployed: ${sourceInbox.address}`
  );
  console.log("[deploy-full-testnet] Ensuring source miner is registered...");
  await ensureMinerRegistered({
    inbox: sourceInbox,
    miner: minerAddress,
    publicClient: sourcePublicClient,
    walletClient: sourceWalletClient,
  });
  console.log("[deploy-full-testnet] Deploying source PriceOracle and wiring inbox...");
  const sourcePriceOracle = await deployAndWireTestnetPriceOracle({
    viem: sourceViem,
    publicClient: sourcePublicClient,
    walletClient: sourceWalletClient,
    chainId: sourceChainId,
    inbox: sourceInbox,
  });
  console.log(`[deploy-full-testnet] Source PriceOracle: ${sourcePriceOracle.address}`);
  const [sourceLocalUsd, sourceRemoteUsd] = await sourcePriceOracle.read.getPricesUSD();
  console.log(
    `[deploy-full-testnet] Source oracle getPricesUSD (18-dec): local=${sourceLocalUsd} remote=${sourceRemoteUsd}`
  );
  console.log("[deploy-full-testnet] Configuring source inbox min fees (local=ETH, remote=COTI)…");
  await configureTestnetInboxMinFees({
    inbox: sourceInbox,
    publicClient: sourcePublicClient,
    walletClient: sourceWalletClient,
    chainId: sourceChainId,
  });
  console.log("[deploy-full-testnet] Configuring source inbox gasPriceBounds…");
  await configureInboxGasPriceBounds({
    inbox: sourceInbox,
    publicClient: sourcePublicClient,
    walletClient: sourceWalletClient,
    chainId: sourceChainId,
  });
  await appendDeploymentLog({
    contract: "Inbox",
    address: sourceInbox.address,
    chainId: sourceChainId,
    network: sourceChainLabel,
  });
  await appendDeploymentLog({
    contract: "PriceOracle",
    address: sourcePriceOracle.address,
    chainId: sourceChainId,
    network: sourceChainLabel,
  });

  console.log("[deploy-full-testnet] Deploying deterministic COTI Inbox via CreateX...");
  const cotiInboxDeploy = await deployDeterministicInbox({
    viem: cotiViem,
    publicClient: cotiPublicClient,
    walletClient: cotiWalletClient,
  });
  const cotiInbox = cotiInboxDeploy.inbox;
  console.log(
    cotiInboxDeploy.alreadyDeployed
      ? `[deploy-full-testnet] COTI Inbox already deployed: ${cotiInbox.address}`
      : `[deploy-full-testnet] COTI Inbox deployed: ${cotiInbox.address}`
  );
  console.log(
    "[deploy-full-testnet] CreateX note: address depends on Inbox bytecode (Ownable(address(1))); bump inboxSalt.label if bytecode changes."
  );
  console.log("[deploy-full-testnet] Deploying MpcExecutor...");
  const cotiExecutor = await cotiViem.deployContract("MpcExecutor", [cotiInbox.address], {
    client: { public: cotiPublicClient, wallet: cotiWalletClient },
  });
  console.log(`[deploy-full-testnet] MpcExecutor deployed: ${cotiExecutor.address}`);
  console.log("[deploy-full-testnet] Ensuring COTI miner is registered...");
  await ensureMinerRegistered({
    inbox: cotiInbox,
    miner: minerAddress,
    publicClient: cotiPublicClient,
    walletClient: cotiWalletClient,
  });
  console.log("[deploy-full-testnet] Deploying COTI PriceOracle and wiring inbox...");
  const cotiPriceOracle = await deployAndWireTestnetPriceOracle({
    viem: cotiViem,
    publicClient: cotiPublicClient,
    walletClient: cotiWalletClient,
    chainId: cotiChainIdNumber,
    inbox: cotiInbox,
  });
  console.log(`[deploy-full-testnet] COTI PriceOracle: ${cotiPriceOracle.address}`);
  const [cotiLocalUsd, cotiRemoteUsd] = await cotiPriceOracle.read.getPricesUSD();
  console.log(
    `[deploy-full-testnet] COTI oracle getPricesUSD (18-dec): local=${cotiLocalUsd} remote=${cotiRemoteUsd}`
  );
  console.log("[deploy-full-testnet] Configuring COTI inbox min fees (local=COTI, remote=ETH)…");
  await configureTestnetInboxMinFees({
    inbox: cotiInbox,
    publicClient: cotiPublicClient,
    walletClient: cotiWalletClient,
    chainId: cotiChainIdNumber,
  });
  console.log("[deploy-full-testnet] Configuring COTI inbox gasPriceBounds (non-EIP-1559)…");
  await configureInboxGasPriceBounds({
    inbox: cotiInbox,
    publicClient: cotiPublicClient,
    walletClient: cotiWalletClient,
    chainId: cotiChainIdNumber,
  });
  await appendDeploymentLog({
    contract: "Inbox",
    address: cotiInbox.address,
    chainId: cotiChainIdNumber,
    network: cotiChainLabel,
  });
  await appendDeploymentLog({
    contract: "PriceOracle",
    address: cotiPriceOracle.address,
    chainId: cotiChainIdNumber,
    network: cotiChainLabel,
  });
  await appendDeploymentLog({
    contract: "MpcExecutor",
    address: cotiExecutor.address,
    chainId: cotiChainIdNumber,
    network: cotiChainLabel,
  });

  let millionaireAddress: `0x${string}` | undefined;
  if (!ONLY_MPC_ADDER) {
    console.log("[deploy-full-testnet] Deploying Millionaire...");
    const millionaire = await sourceViem.deployContract("Millionaire", [sourceInbox.address], {
      client: { public: sourcePublicClient, wallet: sourceWalletClient },
    });
    millionaireAddress = millionaire.address;
    console.log(`[deploy-full-testnet] Millionaire deployed: ${millionaire.address}`);
    console.log("[deploy-full-testnet] Configuring Millionaire...");
    await millionaire.write.configure(podConfigureKeepInbox(cotiExecutor.address, cotiChainId));
    console.log("[deploy-full-testnet] Millionaire configured");
    await appendDeploymentLog({
      contract: "Millionaire",
      address: millionaire.address,
      chainId: sourceChainId,
      network: sourceChainLabel,
    });
  }

  console.log("[deploy-full-testnet] Deploying MpcAdder...");
  const mpcAdder = await sourceViem.deployContract("MpcAdder", [sourceInbox.address], {
    client: { public: sourcePublicClient, wallet: sourceWalletClient },
  });
  console.log(`[deploy-full-testnet] MpcAdder deployed: ${mpcAdder.address}`);
  const fundAdder = await sourceWalletClient.sendTransaction({ to: mpcAdder.address, value: 10n ** 18n });
  await sourcePublicClient.waitForTransactionReceipt({ hash: fundAdder });
  console.log("[deploy-full-testnet] Configuring MpcAdder...");
  await mpcAdder.write.configure(podConfigureKeepInbox(cotiExecutor.address, cotiChainId));
  console.log("[deploy-full-testnet] MpcAdder configured");
  await appendDeploymentLog({
    contract: "MpcAdder",
    address: mpcAdder.address,
    chainId: sourceChainId,
    network: sourceChainLabel,
  });

  let pErc20Address: `0x${string}` | undefined;
  if (!ONLY_MPC_ADDER) {
    console.log("[deploy-full-testnet] Deploying PErc20...");
    const pErc20 = await sourceViem.deployContract("PErc20", [sourceInbox.address], {
      client: { public: sourcePublicClient, wallet: sourceWalletClient },
    });
    pErc20Address = pErc20.address;
    console.log(`[deploy-full-testnet] PErc20 deployed: ${pErc20.address}`);
    const fundPe = await sourceWalletClient.sendTransaction({ to: pErc20.address, value: 10n ** 18n });
    await sourcePublicClient.waitForTransactionReceipt({ hash: fundPe });
    console.log("[deploy-full-testnet] Configuring PErc20...");
    await pErc20.write.configure(podConfigureKeepInbox(cotiExecutor.address, cotiChainId));
    console.log("[deploy-full-testnet] PErc20 configured");
    await appendDeploymentLog({
      contract: "PErc20",
      address: pErc20.address,
      chainId: sourceChainId,
      network: sourceChainLabel,
    });
  }

  console.log("[deploy-full-testnet] Deploying PErc20Coti...");
  const pErc20Coti = await cotiViem.deployContract("PErc20Coti", [cotiInbox.address], {
    client: { public: cotiPublicClient, wallet: cotiWalletClient },
  });
  console.log(`[deploy-full-testnet] PErc20Coti deployed: ${pErc20Coti.address}`);
  await appendDeploymentLog({
    contract: "PErc20Coti",
    address: pErc20Coti.address,
    chainId: cotiChainIdNumber,
    network: cotiChainLabel,
  });

  const deployConfig = await readDeployConfig();
  const sourceChainConfig = getChainConfig(deployConfig, sourceChainId, "source");
  sourceChainConfig.inbox = sourceInbox.address;
  sourceChainConfig.priceOracle = sourcePriceOracle.address;
  const cotiChainConfig = getChainConfig(deployConfig, cotiChainIdNumber, "coti");
  cotiChainConfig.inbox = cotiInbox.address;
  cotiChainConfig.cotiExecutor = cotiExecutor.address;
  cotiChainConfig.priceOracle = cotiPriceOracle.address;
  await fs.writeFile(deployConfigPath, `${JSON.stringify(deployConfig, null, 2)}\n`, "utf8");
  console.log("[deploy-full-testnet] Updated deployConfig.json");

  await verifyContract(SOURCE_NETWORK, "Inbox", sourceInbox.address, []);
  await verifyContract(
    SOURCE_NETWORK,
    "PriceOracle",
    sourcePriceOracle.address,
    [sourceWalletClient.account.address]
  );
  await verifyContract(COTI_NETWORK, "Inbox", cotiInbox.address, []);
  await verifyContract(
    COTI_NETWORK,
    "PriceOracle",
    cotiPriceOracle.address,
    [cotiWalletClient.account.address]
  );
  await verifyContract(COTI_NETWORK, "MpcExecutor", cotiExecutor.address, [cotiInbox.address]);
  if (millionaireAddress) {
    await verifyContract(SOURCE_NETWORK, "Millionaire", millionaireAddress, [sourceInbox.address]);
  }
  await verifyContract(SOURCE_NETWORK, "MpcAdder", mpcAdder.address, [sourceInbox.address]);
  if (pErc20Address) {
    await verifyContract(SOURCE_NETWORK, "PErc20", pErc20Address, [sourceInbox.address]);
  }
  await verifyContract(COTI_NETWORK, "PErc20Coti", pErc20Coti.address, [cotiInbox.address]);

  console.log("[deploy-full-testnet] Done");
};

main().catch((error) => {
  console.error("[deploy-full-testnet] Failed:", error);
  process.exitCode = 1;
});
