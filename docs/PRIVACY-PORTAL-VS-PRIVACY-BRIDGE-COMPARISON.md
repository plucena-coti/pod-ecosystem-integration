# PrivacyPortal vs PrivacyBridge — admin / operator surface

Role model (not 1-1):

| Concern | PrivacyBridge (PB) | Privacy Portal (PP) |
|---------|--------------------|---------------------|
| Admin | `Ownable.owner` (+ `DEFAULT_ADMIN_ROLE`) on the bridge | Factory `DEFAULT_ADMIN_ROLE` via `isAdmin` (portal has no Ownable) |
| Operator | `OPERATOR_ROLE` on the bridge | Factory `OPERATOR_ROLE` via `isOperator` |
| Scope | Per-bridge instance | Factory roles apply to **all** portals on that factory |
| Oracle | Bridge-owned price oracle + `setMaxOracleAge` | Shared `PoDPriceOracle` (+ Band/Chainlink live adapter); factory `setPriceOracle` only |

## Admin / operator function map

| Functionality | Function in PB | Function in PP Factory | Function in PP instance |
|---------------|----------------|------------------------|-------------------------|
| Pause user flows | `pause()` (`onlyOwner`) | `pause()` (`DEFAULT_ADMIN_ROLE`) — deposits/withdrawals on all portals | `pause()` (`onlyFactoryAdmin`) — this portal only |
| Unpause user flows | `unpause()` (`onlyOwner`) | `unpause()` (`DEFAULT_ADMIN_ROLE`) | `unpause()` (`onlyFactoryAdmin`) |
| Add blacklist entry | `addToBlacklist(account)` (`onlyOwner`) | `addToBlacklist(account)` (`DEFAULT_ADMIN_ROLE`) — factory-wide | `addToBlacklist(account)` (`onlyFactoryAdmin`) — portal-local |
| Remove blacklist entry | `removeFromBlacklist(account)` (`onlyOwner`) | `removeFromBlacklist(account)` (`DEFAULT_ADMIN_ROLE`) | `removeFromBlacklist(account)` (`onlyFactoryAdmin`) |
| Per-tx deposit/withdraw limits | `setLimits(minDeposit, maxDeposit, minWithdraw, maxWithdraw)` (`onlyOwner`) | | `setLimits(...)` (`onlyFactoryAdmin`) |
| Soft-disable deposits | `setIsDepositEnabled(enabled)` (`onlyOperator`) | | `setIsDepositEnabled(enabled)` (`onlyFactoryOperator`) |
| Deposit fee parameters | `setDepositDynamicFee(fixed, bps, max)` (`onlyOperator`) | `setDefaultDepositFee(...)` (`OPERATOR_ROLE`) | `setDepositFee(...)` (`onlyFactoryOperator`) — per-portal override |
| Withdraw fee parameters | `setWithdrawDynamicFee(fixed, bps, max)` (`onlyOperator`) | `setDefaultWithdrawFee(...)` (`OPERATOR_ROLE`) | `setWithdrawFee(...)` (`onlyFactoryOperator`) — per-portal override |
| Clear deposit fee override | | | `clearDepositFeeOverride()` (`onlyFactoryOperator`) |
| Clear withdraw fee override | | | `clearWithdrawFeeOverride()` (`onlyFactoryOperator`) |
| Set price oracle | `setPriceOracle(oracle)` (`onlyOwner`) | `setPriceOracle(oracle)` (`DEFAULT_ADMIN_ROLE`) | |
| Set max oracle age / staleness | `setMaxOracleAge(maxOracleAge)` (`onlyOwner`) | *(adapter/`maxStaleness` at oracle deploy — no factory setter)* | |
| Sweep accumulated protocol fees | `withdrawCotiFees(amount)` / native `withdrawFees(amount)` (`onlyOwner`) | | `withdrawPortalFees(amount)` (`onlyFactoryAdmin`) |
| Rescue native (paused) | `rescueNative(amount)` (`onlyOwner`, whenPaused) — native bridge | | `rescueNative(amount)` (`onlyFactoryAdmin`, whenPaused) |
| Rescue ERC20 (paused) | `rescueERC20(token, amount)` (`onlyOwner`, whenPaused) — ERC20 bridges | | `rescueERC20(token, amount)` (`onlyFactoryAdmin`, whenPaused) |
| Rotate fee recipient | *(immutable at deploy)* | *(immutable at factory deploy)* | |
| Rotate rescue recipient | *(immutable at deploy)* | `setRescueRecipient(addr)` (`DEFAULT_ADMIN_ROLE`) | |
| Grant / revoke operator | `addOperator` / `removeOperator` (`DEFAULT_ADMIN_ROLE`) | `grantRole(OPERATOR_ROLE, …)` / `revokeRole(OPERATOR_ROLE, …)` (`DEFAULT_ADMIN_ROLE`) | |
| Transfer admin / ownership | `transferOwnership(newOwner)` (`onlyOwner`; revokes roles then re-grants to new owner) | `grantRole` / `revokeRole` (`DEFAULT_ADMIN_ROLE`) | |
| Allow / deny portal deployers | | `setDeployer(deployer, allowed)` (`DEFAULT_ADMIN_ROLE`) | |
| Create portal + pToken | | `createPortal(...)` (`onlyDeployer`) | |
| Configure inbox / COTI routing | | `configureRouting(inbox, cotiChainId, mother)` (`DEFAULT_ADMIN_ROLE`) | |
| Reconfigure existing pToken peers | | `configurePToken(pToken, inbox, cotiSide)` (`DEFAULT_ADMIN_ROLE`) | |
| Transfer pToken Ownable | | `transferPTokenOwnership(pToken, newOwner)` (`DEFAULT_ADMIN_ROLE`) | |
| Batch-burn pending private supply | | | `burnAccumulatedPTokens(amount, burnCallbackFee)` (`onlyFactoryAdmin`) |
| Force-refund stuck deposit escrow | | | `adminRefundPendingDeposit(requestId)` (`onlyFactoryAdmin`, whenPaused) |

Permissionless recovery (not admin-gated; listed for contrast):

| Functionality | PB | PP |
|---------------|----|----|
| Refund failed deposit mint (`SystemFailed`) | n/a (sync mint) | `refundFailedDeposit(requestId)` |
| Cancel failed withdrawal transfer | n/a | `cancelFailedWithdrawal(withdrawalId)` |
| Claim refundable native fee excess | `claimRefundableNativeExcess()` | n/a |

## Notes

- PB fee and rescue destinations are fixed at construction. PP fee recipient is also fixed at factory deploy; rescue recipient can still be rotated via `setRescueRecipient`.
- PP fee knobs are split: factory defaults for new quotes, optional per-portal overrides (+ clear back to defaults). Dynamic % fees read **live** prices from `PoDPriceOracle.getLivePrices` (Band/Chainlink adapter); inbox fees use the oracle **cache** refreshed by `refreshCache()`.
- PP has dual pause and dual blacklist (factory + instance). Either pause/blacklist path can block users.
- Portal instance admin/operator checks always read live factory roles (`isAdmin` / `isOperator`); there is no per-portal Ownable.
- `adminRefundPendingDeposit` requires an independent check that the COTI mint can no longer succeed; a late mint after refund can create unbacked pToken supply.

## Live contract addresses

Sources: PEI `deployConfig.json` (PoD Privacy Portal + inbox), `coti-contracts` mainnet bridge verify/limits scripts, and docs `coti-privacy-portal/developer-guide/contract-addresses.md` (COTI testnet bridges). Prefer those files if addresses drift after redeploy.

### PoD Privacy Portal — Sepolia (11155111) ↔ COTI testnet

| Contract | Address |
|----------|---------|
| Inbox | `0x3b8B70819f27e0438cBcE7f31894f799da52648F` |
| PoDPriceOracle | `0x3281160888138e786c3eb0f4f4cc51453d8dfeff` |
| Live adapter (Band) | `0x31bbf71c03854c0fd7949a62509ba867585f7af4` |
| PrivacyPortalFactory | `0x0117d640ce96805739cf5f82683b0dd9532541ee` |
| Portal implementation | `0x7f36e1eabbee6a1cd724b4ade37fe475f807d982` |
| pToken implementation | `0xe8e2fdd23ea2d5f9bb4632d11f7267602a059e5d` |
| pMTT portal / pToken | `0x621E744eF059262Fd531a0f345d38Ce31d92D105` / `0x1566ADA98695D39b2D5A8e1359d7Af9D567c74ab` |
| pUSDC portal / pToken | `0x79679CE36664c3b1360501B2c7ea6bbee65a2717` / `0xc04Cb7256E849C34877D801A77f9165BaC209c06` |
| pWETH portal / pToken | `0x7666F6576956530E2D56CDB548b71e62286d1d18` / `0xD586736543F7666d1adbF862B769Ba838a9a3deD` |

### PoD Privacy Portal — Avalanche Fuji (43113) ↔ COTI testnet

| Contract | Address |
|----------|---------|
| Inbox | `0x3b8B70819f27e0438cBcE7f31894f799da52648F` |
| PoDPriceOracle | `0xf2283ca93a6747c547a961c50d0393d549c57268` |
| Live adapter (Chainlink) | `0xdeb631df0735984da95f77abc6f394bf27a7c230` |
| PrivacyPortalFactory | `0xf3cf653e1baee7b4e4001067780dee38991b1cbd` |
| Portal implementation | `0x63e97937e42c153cdeb25e9aca9d3d0373aec0a5` |
| pToken implementation | `0xa7e4838327317f4ce6cc8b5ab07a57fdba842c77` |
| pMTT portal / pToken | `0xf4100d21eB4B1a66aDde58A01D1E32356F268b3F` / `0xFC6283a9000d7D5Cf8A058A04A9ED90265Af1634` |
| pUSDC portal / pToken | `0x090D2dc8C38275939b9381Ff2aa53012Ff412E34` / `0xe2235E064a3CEB5F1765c3b095855549d3c8A8a4` |
| pWAVAX portal / pToken | `0x20e7239cd78BDf2E8f34c52947e54fE68D7b536F` / `0x0c58954d91392794A50F610dF8c84228D63BE9D4` |

### COTI testnet (7082400) — PoD peers + PrivacyBridge

| Contract | Address |
|----------|---------|
| Inbox | `0x3b8B70819f27e0438cBcE7f31894f799da52648F` |
| MpcExecutor | `0x6804961167c3c8ef2bf6839ddcf51ec1fbe800c3` |
| PodErc20CotiMother | `0xaeb2271959031b65cba63302cff5d970b49d4a7b` |
| PriceOracle (plain) | `0xb471e172876ba9bb24a43528779ea31e0b0bda2f` |
| PrivacyBridgeCotiNative | `0xb8Bb4fe953eAa53D528FAc95C1d9955B2b60D582` |
| PrivacyBridgeWETH | `0x1841071A0296364739370a6d2F64c0eE46361fA0` |
| PrivacyBridgeWBTC | `0x362faD66210401ADfAf27B98776F1e8D21dfc529` |
| PrivacyBridgeUSDT | `0x73116aa5a50cADca47FD03Ca0B80D133346442FA` |
| PrivacyBridgeUSDCe | `0x9C92Ad40553758C3d11Dcd8495Ee0ce3fd8fE0A1` |
| PrivacyBridgeWADA | `0x3cB6e1E9cd504669DAb49910c30cDAfA8D05B641` |
| PrivacyBridgegCOTI | `0x8A6ca3984Cb187f90C9Bd24c71C70eF97A71A8fA` |

### COTI mainnet (2632500) — PrivacyBridge + shared fee/oracle

| Contract | Address |
|----------|---------|
| Fee recipient (bridge ctor) | `0x0B90092a3a638fe52d938133c67c5b447Df9800a` |
| Rescue recipient (bridge ctor) | `0xcaabe69719468e677ca5a1CC4c1A7edc38c69022` |
| Price oracle (bridge ctor) | `0x830c5112E677459648C1aa7Bc5Dd65A36d71Aa4D` |
| PrivacyBridgeCotiNative | `0x44D864973392064304dD88E2BDef39fF1ab11b7b` |
| PrivacyBridgeWETH | `0x7286c83300f0C7131b4006f3cf9F8e44BeB45c13` |
| PrivacyBridgeWBTC | `0xc3B7EdEe4f1c0A0bA1AcD341e4982371eC869862` |
| PrivacyBridgeUSDT | `0x7685B473DAF1c6DeD815Ca64C6fa18Da2227440D` |
| PrivacyBridgeUSDCe | `0x29334fC23ffa2c44AF1b372336C2296591Eadd86` |
| PrivacyBridgeWADA | `0xFa2126C07F517013c8d237cc465342da89B96f92` |
| PrivacyBridgegCoti | `0xD4e0d9AB16b48c68044cB6aeA3A089380d6D8cD4` |
