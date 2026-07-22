# Fee + Oracle Reference

## Contract Roles

| Contract | Role for UI |
|----------|-------------|
| `PrivacyPortal` | User deposit/withdraw; `estimateDepositFees` / `estimateWithdrawFees` |
| `PrivacyPortalFactory` | `priceOracle`, `nativeToken`, default fee config, portal registry |
| `PoDPriceOracle` | `getLivePrice` / `getLivePrices` for portal dynamic fees |
| `BandLiveOracle` / `ChainlinkLiveOracle` | Low-level feed adapter (usually read via `PoDPriceOracle` only) |
| `PodERC20` (pToken) | `estimateFee()` — PoD inbox fee component |

Portal `factory` is the pause/fee/operator authority; resolve via portal or config.

## ABI Signature Diff (Migration)

### Deposit (ERC20)

```solidity
// OLD
function deposit(address recipient, uint256 amount, uint256 mintCallbackFee) external payable;

// NEW
function deposit(address recipient, uint256 amount, uint256 portalFee, uint256 mintCallbackFee) external payable;
// msg.value must be > portalFee; mint fee = msg.value - portalFee
```

### Deposit (native WETH/WAVAX)

```solidity
function depositNative(address recipient, uint256 amount, uint256 portalFee, uint256 mintCallbackFee) external payable;
// msg.value must be > amount + portalFee; mint fee = msg.value - amount - portalFee
```

### Withdraw

```solidity
// OLD (removed burn from user tx)
function requestWithdrawWithPermit(
    address recipient, uint256 amount,
    uint256 transferFee, uint256 transferCallbackFee,
    uint256 burnFee, uint256 burnCallbackFee,
    uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s
) external payable;

// NEW
function requestWithdrawWithPermit(
    address recipient, uint256 amount,
    uint256 portalFee,
    uint256 transferFee, uint256 transferCallbackFee,
    uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s
) external payable;
// msg.value must be >= portalFee; transferFee must equal msg.value - portalFee
```

### New view helpers

```solidity
function estimateDepositFees(uint256 amount) external view returns (
    uint256 portalFee, bool usedDynamicPricing,
    uint256 mintTotalFee, uint256 mintCallbackFee
);

function estimateWithdrawFees(uint256 amount) external view returns (
    uint256 portalFee, bool usedDynamicPricing,
    uint256 transferTotalFee, uint256 transferCallbackFee
);

function estimateBatchBurnFees(uint256 amount) external view returns (
    uint256 burnTotalFee, uint256 burnCallbackFee
);
```

Factory-level portal fee preview (without PoD component):

```solidity
function estimateDepositPortalFee(address underlying, uint256 amount, uint8 decimals) external view returns (uint256 fee, bool usedDynamicPricing);
function estimateWithdrawPortalFee(address underlying, uint256 amount, uint8 decimals) external view returns (uint256 fee, bool usedDynamicPricing);
function getFeeConfig(bool isDeposit) external view returns (PortalFeeConfig memory);
```

## Fee Config Shape

```solidity
struct PortalFeeConfig {
    uint256 fixedFee;        // native wei floor
    uint256 percentageBps;   // parts per 1_000_000 (100_000 = 10%)
    uint256 maxFee;          // native wei cap
}
```

Packed as `bytes32`: `uint96 fixed | uint32 bps | uint128 max`.

## Oracle Interface

```solidity
interface IPodPriceOracle {
    /// @return priceUsd 18-decimal USD per 1 whole token
    function getLivePrice(address token) external view returns (uint256 priceUsd);

    function getLivePrices(address tokenA, address tokenB)
        external view returns (uint256 priceA, uint256 priceB);
}
```

Adapters return `0` on failure/stale/unset feeds — never revert.

## Deployed Addresses (check `deployConfig.json` for updates)

### Sepolia (`11155111`)

| Key | Address |
|-----|---------|
| `priceOracle` | `0x7eecdceec31d285aee99c7960b405f63593903d1` |
| `oracle.liveAdapter` (Band) | `0x9d6ed5b1f4162aeca9140a61e9e7a5ca7043c3dd` |
| `privacyPortalFactory` | `0xe26a0db663a9d546ab4dfd02d8b4305e3df9ce73` |
| Native (WETH) | `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` |

Example portals: `privacyPortalTokens.pWETH`, `pUSDC`, `pMTT` in config.

### Fuji (`43113`)

| Key | Address |
|-----|---------|
| `priceOracle` | `0xb06340c020274ef5d92f664070966402a4d27712` |
| `oracle.liveAdapter` (Chainlink) | `0x7eba6cfba05baf066a8072ef50e41065c01cdcd0` |
| Chainlink AVAX/USD feed | `0x5498BB86BC934c8D34FDA08E81D444153d0D06aD` |
| `privacyPortalFactory` | `0xcf06fbf94af5e9eceb15aa1ba6458b72521424fd` |
| Native (WAVAX) | `0xd00ae08403B9bbb9124bB305C09058E32C39A48c` |

Example portals: `privacyPortalTokens.pWAVAX`, `pUSDC`, `pMTT` in config.

## Common Reverts (fee-related)

| Error | Cause | UI fix |
|-------|-------|--------|
| `InsufficientPortalFee(expected, actual)` | `portalFee` below dynamic/fixed floor | Re-quote `estimateDepositFees` / `estimateWithdrawFees` |
| `ExcessivePortalFee(max, actual)` | `portalFee` above max | Re-quote; don't add buffer to portal fee |
| `IncorrectFee(expected, actual)` | Wrong `msg.value` or callback mismatch | Set `value = portalFee + podTotal`; pass exact callback arg from estimate |
| Oracle returns `0` | Stale/unwired feed | Show fixed-fee-only quote; warn user dynamic pricing unavailable |

## Inbox vs Portal Fee (don't conflate)

- **Portal fee** — stays with portal (`accumulatedPortalFees`); priced in native token; may use oracle for % of USD transaction value.
- **PoD inbox fee** — forwarded with `pToken.mint` / `pToken.transfer` to pay cross-chain messaging; from inbox fee config on the pToken side; **independent** of portal fee math.

The portal estimate helpers return both components; always add them for total `msg.value`.

## TypeScript Fee Mirror (optional client-side preview)

See `test/privacy/oracle-test-utils.ts` → `expectedDynamicPortalFee` for off-chain verification against on-chain quotes.
