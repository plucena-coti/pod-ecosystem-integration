import "dotenv/config";
import "@nomicfoundation/hardhat-verify";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

const envOrConfig = (key: string) => process.env[key] ?? configVariable(key);
const privateKeyFor = (key: string) =>
  process.env[key] ?? process.env.PRIVATE_KEY ?? configVariable(key);

/** COTI testnet: prefer dedicated key, then `_PRIVATE_KEY` (miner / alternate account in `.env`), then `PRIVATE_KEY`. */
const privateKeyForCotiTestnet = () =>
  process.env.COTI_TESTNET_PRIVATE_KEY?.trim() ||
  process.env._PRIVATE_KEY?.trim() ||
  process.env.PRIVATE_KEY?.trim() ||
  configVariable("PRIVATE_KEY");

/** Hardhat mnemonic account #0 — used by `COTI_BACKEND=sim` dual-chain tests. */
const HARDHAT_DEFAULT_PK0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** Unique 0x-prefixed keys for Hardhat / COTI test wallets (order preserved). */
const collectTestPrivateKeys = (): `0x${string}`[] => {
  const raw = [
    process.env.PRIVATE_KEY?.trim(),
    process.env.COTI_TESTNET_PRIVATE_KEY?.trim(),
    process.env._PRIVATE_KEY?.trim(),
    process.env.PRIVATE_KEY_ACCOUNT_2?.trim(),
    process.env.SEPOLIA_PRIVATE_KEY?.trim(),
  ].filter((k): k is string => !!k);
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const key of raw) {
    const normalized = (key.startsWith("0x") ? key : `0x${key}`).toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized as `0x${string}`);
    }
  }
  // Append Hardhat #0 so sim dual-chain `getWalletClient` can unlock it without reordering wallet[0].
  if (!seen.has(HARDHAT_DEFAULT_PK0)) {
    out.push(HARDHAT_DEFAULT_PK0);
  }
  return out;
};

const hardhatTestAccounts = () =>
  collectTestPrivateKeys().map((privateKey) => ({
    privateKey,
    balance: "100000000000000000000",
  }));

const cotiTestnetAccounts = () => collectTestPrivateKeys();

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  verify: {
    etherscan: {
      apiKey: envOrConfig("ETHERSCAN_API_KEY"),
      enabled: true,
    },
  },
  chainDescriptors: {
    7082400: {
      name: "COTI Testnet",
      chainType: "generic",
      blockExplorers: {
        blockscout: {
          name: "COTI Testnet Blockscout",
          url: "https://testnet.cotiscan.io",
          apiUrl: "https://testnet.cotiscan.io/api",
        },
      },
    },
    7082401: {
      name: "simCoti",
      chainType: "generic",
    },
    43113: {
      name: "Avalanche Fuji",
      chainType: "l1",
      blockExplorers: {
        etherscan: {
          name: "Snowscan (Fuji)",
          url: "https://testnet.snowscan.xyz",
          // Etherscan V2 multichain endpoint; `chainid=43113` routes to Snowscan
          // (Etherscan's Avalanche deployment). Uses the single ETHERSCAN_API_KEY.
          apiUrl: "https://api.etherscan.io/v2/api",
        },
      },
    },
  },
  solidity: {
    // Must be ≥0.8.20 for @openzeppelin/contracts@5.x (e.g. Ownable).
    // Do not set `path` to soljson.js — that forces the WASM compiler, which OOMs on
    // aarch64 when compiling vendored MpcCore.sol. Let Hardhat download the native
    // linux-arm64 binary instead (see preferWasm: false).
    //
    // `paris`: COTI testnet rejects Shanghai `PUSH0`. Keep the whole tree on Paris so
    // Inbox / MpcExecutor / mothers deploy without Shanghai+ opcodes.
    version: "0.8.28",
    preferWasm: false,
    settings: {
      evmVersion: "paris",
      viaIR: true,
      optimizer: {
        enabled: true,
        // Lower runs shrink deployment size (higher runtime gas). For Inbox ~29kB, try 1–200.
        runs: 10,
      },
    },
  },
  // Configure the default hardhat network
  // Chain ID can be overridden via HARDHAT_CHAIN_ID environment variable
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: parseInt(process.env.HARDHAT_CHAIN_ID || "31337"),
      accounts: hardhatTestAccounts().length > 0 ? hardhatTestAccounts() : undefined,
    },
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: envOrConfig("SEPOLIA_RPC_URL"),
      accounts: [privateKeyFor("SEPOLIA_PRIVATE_KEY")],
    },
    cotiTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 7082400,
      url: envOrConfig("COTI_TESTNET_RPC_URL"),
      accounts: cotiTestnetAccounts(),
    },
    // In-process simCoti (fake MPC precompile). Used when COTI_BACKEND=sim.
    simCoti: {
      type: "edr-simulated",
      chainId: parseInt(process.env.SIM_COTI_CHAIN_ID || "7082401"),
      accounts: hardhatTestAccounts().length > 0 ? hardhatTestAccounts() : undefined,
    },
    localSimCoti: {
      type: "http",
      chainType: "l1",
      chainId: parseInt(process.env.SIM_COTI_CHAIN_ID || "7082401"),
      url: process.env.SIM_COTI_RPC_URL ?? "http://127.0.0.1:8546",
      accounts: cotiTestnetAccounts(),
    },
    localSepolia: {
      type: "http",
      chainType: "l1",
      chainId: 31337,
      url: process.env.LOCAL_SEPOLIA_RPC_URL ?? "http://127.0.0.1:8545",
      accounts: cotiTestnetAccounts(),
    },
    avalancheFuji: {
      type: "http",
      chainType: "l1",
      chainId: 43113,
      url:
        process.env.AVALANCHE_FUJI_RPC_URL ??
        "https://avalanche-fuji-c-chain-rpc.publicnode.com",
      accounts: [privateKeyFor("AVALANCHE_FUJI_PRIVATE_KEY")],
    },
    // Chain 1 for multichain message passing testing
    // Use in-process simulation to avoid external nodes in tests
    chain1: {
      type: "edr-simulated",
      chainId: 31337,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
      },
    },
    // Chain 2 for multichain message passing testing
    // Use in-process simulation to avoid external nodes in tests
    chain2: {
      type: "edr-simulated",
      chainId: 31338,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
      },
    },
  },
});
