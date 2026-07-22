/** Sentinel token address for COTI native USD pricing (manual peg only on most chains). */
export const ORACLE_REMOTE_COTI_TOKEN = "0x000000000000000000000000000000000000C071" as const;

const SEPOLIA_WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" as const;
const FUJI_WAVAX = "0xd00ae08403B9bbb9124bB305C09058E32C39A48c" as const;

export type OracleTokenLegs = {
  localToken: `0x${string}`;
  remoteToken: `0x${string}`;
  portalNative: `0x${string}`;
};

/** Inbox leg + portal native token addresses per chain. */
export const oracleTokensForChain = (chainId: number): OracleTokenLegs => {
  const cotiTestnetId = Number(process.env.COTI_TESTNET_CHAIN_ID || "7082400");
  const simCotiId = Number(process.env.SIM_COTI_CHAIN_ID || "7082401");
  // Hardhat surrogate (31337) or e2e retry aliases (313370000+) that isolate COTI inbound nonces.
  if (chainId === 11155111 || chainId === 31337 || chainId >= 313_370_000) {
    return { localToken: SEPOLIA_WETH, remoteToken: ORACLE_REMOTE_COTI_TOKEN, portalNative: SEPOLIA_WETH };
  }
  if (chainId === 43113) {
    return { localToken: FUJI_WAVAX, remoteToken: ORACLE_REMOTE_COTI_TOKEN, portalNative: FUJI_WAVAX };
  }
  if (chainId === cotiTestnetId || chainId === simCotiId) {
    return { localToken: ORACLE_REMOTE_COTI_TOKEN, remoteToken: SEPOLIA_WETH, portalNative: ORACLE_REMOTE_COTI_TOKEN };
  }
  throw new Error(`Unsupported chainId ${chainId} for oracle token addresses`);
};
