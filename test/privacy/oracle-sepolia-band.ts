import { describe, it } from "node:test";
import { assertUsdPrice18, readBandUsd18 } from "./oracle-test-utils.js";

describe("Sepolia Band oracle", { concurrency: 1, timeout: 60_000 }, async function () {
  it("reads ETH/USD and USDC/USD from live Band StdReference", async function () {
    const ethUsd = await readBandUsd18("ETH");
    const usdcUsd = await readBandUsd18("USDC");
    assertUsdPrice18("ETH/USD", ethUsd, 500, 50_000);
    assertUsdPrice18("USDC/USD", usdcUsd, 0.95, 1.05);
  });
});
