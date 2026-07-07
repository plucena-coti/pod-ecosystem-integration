import { describe, it } from "node:test";
import { getAddress } from "viem";
import {
  SEPOLIA_LIVE_TOKENS,
  SEPOLIA_ORACLE,
  assertUsdPrice18,
  formatUsd18,
  readBandUsd18WithMeta,
  readChainlinkUsd18WithMeta,
  sepoliaPublicClient,
} from "./oracle-test-utils.js";

const pad = (s: string, n: number) => s.padEnd(n);

const formatAge = (updatedAt: bigint): string => {
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(updatedAt));
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86_400)}d ago`;
};

describe("Sepolia live oracle prices", { concurrency: 1, timeout: 120_000 }, async function () {
  it("reads ETH, WBTC, USDC from on-chain Chainlink and Band", async function () {
    const client = sepoliaPublicClient();
    const bandRef = getAddress(SEPOLIA_ORACLE.bandStdRef);

    const [clEth, clBtc, clUsdc] = await Promise.all([
      client.getCode({ address: getAddress(SEPOLIA_ORACLE.chainlink.ethUsd) }),
      client.getCode({ address: getAddress(SEPOLIA_ORACLE.chainlink.btcUsd) }),
      client.getCode({ address: getAddress(SEPOLIA_ORACLE.chainlink.usdcUsd) }),
    ]);
    const bandCode = await client.getCode({ address: bandRef });

    if (!clEth || !clBtc || !clUsdc) {
      throw new Error("Sepolia Chainlink aggregator missing bytecode — check feed addresses");
    }
    if (!bandCode) {
      throw new Error(`Band StdReference has no code at ${bandRef}`);
    }

    console.log("\n  Sepolia live USD prices (on-chain reads)\n");
    console.log(
      `  ${pad("Token", 8)} | ${pad("Chainlink", 14)} | ${pad("Band (USDC)", 14)} | token address`
    );
    console.log(`  ${"-".repeat(8)} | ${"-".repeat(14)} | ${"-".repeat(14)} | ${"-".repeat(42)}`);

    for (const token of SEPOLIA_LIVE_TOKENS) {
      const chainlink = await readChainlinkUsd18WithMeta(token.chainlinkFeed);
      const band = token.bandBase ? await readBandUsd18WithMeta(token.bandBase) : null;
      const bandLabel = band ? `$${formatUsd18(band.price)}` : "n/a";

      console.log(
        `  ${pad(token.name, 8)} | $${pad(formatUsd18(chainlink.price), 13)} | ${pad(bandLabel, 14)} | ${token.token}`
      );
      console.log(
        `  ${"".padEnd(8)} | CL ${token.chainlinkFeed} (${formatAge(chainlink.updatedAt)})` +
          (band
            ? ` | Band ${token.bandBase}/USDC @ ${bandRef} (${formatAge(band.updatedAt)})`
            : " | Band: BTC not listed on Sepolia StdReference")
      );

      assertUsdPrice18(`${token.name} Chainlink`, chainlink.price, token.minUsd, token.maxUsd);

      if (band && token.bandBase) {
        const bandMin = token.bandMinUsd ?? token.minUsd;
        const bandMax = token.bandMaxUsd ?? token.maxUsd;
        assertUsdPrice18(`${token.name} Band`, band.price, bandMin, bandMax);
      }
    }

    console.log("");
  });
});
