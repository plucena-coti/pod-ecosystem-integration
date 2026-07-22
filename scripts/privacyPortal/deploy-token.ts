import {
  allowlistFactoryOnMother,
  connectPrivacyPortalNetwork,
  createSourcePortalAndPToken,
  DEFAULT_COTI_NETWORK,
  DEFAULT_SOURCE_NETWORK,
  deployCotiMother,
  deploySourceFactory,
  envAddress,
  envBigInt,
  envString,
  getCotiMotherFromConfig,
  getInboxFromConfig,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const sourceNetwork = process.env.SOURCE_NETWORK || DEFAULT_SOURCE_NETWORK;
  const cotiNetwork = process.env.COTI_NETWORK || DEFAULT_COTI_NETWORK;
  const underlying = envAddress("UNDERLYING_TOKEN");
  const name = envString("PTOKEN_NAME");
  const symbol = envString("PTOKEN_SYMBOL");
  const decimals = Number(process.env.PTOKEN_DECIMALS || "18");
  const owner = optionalEnvAddress("FACTORY_OWNER");

  const source = await connectPrivacyPortalNetwork(sourceNetwork);
  const coti = await connectPrivacyPortalNetwork(cotiNetwork);

  let cotiMother = optionalEnvAddress("COTI_MOTHER");
  if (!cotiMother) {
    try {
      cotiMother = await getCotiMotherFromConfig(coti);
    } catch {
      const cotiInbox = await getInboxFromConfig(coti, "coti");
      cotiMother = (await deployCotiMother(coti, { inbox: cotiInbox, owner })).mother;
    }
  }

  let sourceFactory = optionalEnvAddress("SOURCE_FACTORY");
  if (!sourceFactory) {
    const sourceInbox = await getInboxFromConfig(source, "source");
    const cotiChainId = envBigInt("COTI_CHAIN_ID", BigInt(coti.chainId));
    sourceFactory = (
      await deploySourceFactory(source, { inbox: sourceInbox, cotiChainId, cotiMother, owner })
    ).factory;
  }

  await allowlistFactoryOnMother(coti, {
    mother: cotiMother,
    sourceChainId: BigInt(source.chainId),
    factory: sourceFactory,
  });

  const sourcePair = await createSourcePortalAndPToken(source, {
    factory: sourceFactory,
    underlying,
    name,
    symbol,
    decimals,
    cotiCtx: coti,
    cotiMother,
    cotiChainId: BigInt(coti.chainId),
  });

  console.log("[privacyPortal:deploy-token] deployed", {
    underlying,
    sourceFactory,
    cotiMother,
    portal: sourcePair.portal,
    pToken: sourcePair.pToken,
  });
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-token] Failed:", error);
  process.exitCode = 1;
});
