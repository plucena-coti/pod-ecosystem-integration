/**
 * Official testnet collateral for Privacy Portal deploy/sync.
 *
 * Native ETH/AVAX flows use the wrapped ERC-20 as portal underlying:
 *   deposit:  native → wrap (WETH/WAVAX.deposit) → approve portal → PrivacyPortal.deposit
 *   withdraw: portal releases WETH/WAVAX → unwrap (withdraw) → native to user
 *
 * Portal/factory/COTI mother treat these like any other ERC-20 underlying.
 */

export const CIRCLE_USDC_FAUCET = "https://faucet.circle.com";

/** Fuji C-Chain test AVAX (gas + wrap to WAVAX). */
export const FUJI_AVAX_FAUCET = "https://core.app/tools/testnet-faucet/";

/** Per source chain: canonical underlying ERC-20 addresses (checksum-agnostic). */
export const CANONICAL_UNDERLYING: Record<number, Record<string, `0x${string}`>> = {
  /** Ethereum Sepolia */
  11155111: {
    /** Circle-issued USDC (6 decimals). Faucet: {@link CIRCLE_USDC_FAUCET} */
    USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    /** Canonical WETH9 on Sepolia (18 decimals). Wrap via `deposit()` payable. */
    WETH: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
  },
  /** Avalanche Fuji C-Chain */
  43113: {
    /** Circle-issued USDC (6 decimals). Faucet: {@link CIRCLE_USDC_FAUCET} */
    USDC: "0x5425890298aed601595a70AB815c96711a31Bc65",
    /** Avalanche canonical WAVAX (18 decimals). Wrap via `deposit()` payable. */
    WAVAX: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
  },
  /** Ethereum mainnet */
  1: {
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  /** Avalanche C-Chain mainnet */
  43114: {
    USDC: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9fcd248",
  },
};

export const canonicalUnderlying = (chainId: number, symbol: string): `0x${string}` | undefined =>
  CANONICAL_UNDERLYING[chainId]?.[symbol];
