import { parseUnits } from "viem";
import { canonicalUnderlying } from "./canonical-collateral.js";

/** USD per 1 whole token (18 decimals) — manual stablecoin peg. */
export const MANUAL_USD_PEG_18 = parseUnits("1", 18);

export const usdcUnderlyingForChain = (chainId: number): `0x${string}` | undefined =>
  canonicalUnderlying(chainId, "USDC");
