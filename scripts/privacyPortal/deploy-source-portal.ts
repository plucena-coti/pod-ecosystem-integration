import {
  connectPrivacyPortalNetwork,
  createSourcePortalAndPToken,
  DEFAULT_COTI_NETWORK,
  envAddress,
  envString,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const ctx = await connectPrivacyPortalNetwork(process.env.SOURCE_NETWORK);
  const coti = await connectPrivacyPortalNetwork(process.env.COTI_NETWORK || DEFAULT_COTI_NETWORK);
  const factory = envAddress("SOURCE_FACTORY");
  const underlying = envAddress("UNDERLYING_TOKEN");
  const cotiMother = envAddress("COTI_MOTHER");
  const name = envString("PTOKEN_NAME");
  const symbol = envString("PTOKEN_SYMBOL");
  const decimals = Number(process.env.PTOKEN_DECIMALS || "18");

  const deployed = await createSourcePortalAndPToken(ctx, {
    factory,
    underlying,
    name,
    symbol,
    decimals,
    cotiCtx: coti,
    cotiMother,
    cotiChainId: BigInt(coti.chainId),
  });
  console.log("[privacyPortal:deploy-source-portal] deployed", deployed);
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-source-portal] Failed:", error);
  process.exitCode = 1;
});
