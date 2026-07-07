import { describe, it } from "node:test";
import { SEPOLIA_ORACLE, assertUsdPrice18, readChainlinkUsd18 } from "./oracle-test-utils.js";

describe("Sepolia Chainlink oracle", { concurrency: 1, timeout: 60_000 }, async function () {
  it("reads ETH/USD and USDC/USD from live Sepolia feeds", async function () {
    const ethUsd = await readChainlinkUsd18(SEPOLIA_ORACLE.chainlink.ethUsd);
    const usdcUsd = await readChainlinkUsd18(SEPOLIA_ORACLE.chainlink.usdcUsd);
    assertUsdPrice18("ETH/USD", ethUsd, 500, 50_000);
    assertUsdPrice18("USDC/USD", usdcUsd, 0.95, 1.05);
  });
});
