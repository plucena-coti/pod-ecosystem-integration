# ETH/PoD UI Reference

## UI Boundary

The UI interacts only with ETH/source-chain contracts:

- Public ERC20, e.g. USDC or test token.
- `PrivacyPortal`.
- PoD-side pToken (`PodERC20` / pERC20).
- Optional source-chain inbox reads only if the app builds deep request diagnostics.

The UI does not need COTI-side ABI calls for normal user flows. COTI is the hidden async execution layer behind PoD requests.

## What Is A PoD Request?

A PoD request is an async cross-chain/private-computation operation started by a source-chain transaction.

Examples:

- Portal deposit calls pToken `mint(...)`.
- Portal withdraw calls pToken `transferFromAndCallWithPermit(...)`.
- Portal callback attempts pToken `burn(...)`.
- Direct pToken transfer/approve/burn calls also submit PoD requests.

For UI purposes:

- Source tx mined = request submitted.
- Request id = handle used to track callback/failure.
- Callback event = success.
- `failedRequests(requestId) != "0x"` or failure event = failure.
- If `failedRequests` ABI-decodes to Inbox `{ErrorData}` (`uint64 code, bytes message`) and `code == 2` (encode/`validateCiphertext` failed; return leg `originalSender` is `SYSTEM_SENDER`), treat as an Inbox **system error** (`requests(...).status == SystemFailed`; COTI app never ran). Clear pending UX and allow a **new** submit — do not call COTI `retryFailedRequest`. App `raise` payloads are dApp-defined — decode only when status is `Failed`.
- `pending == true` from pToken status reads = account cannot start another transfer/burn yet.

### Deposit / withdraw failure recovery

- After a deposit mint request is `SystemFailed`, call `PrivacyPortal.refundFailedDeposit(mintRequestId)` (permissionless; underlying returns to the depositor) to unlock escrow. App `raise` / `Failed` is **not** refundable (mint should not raise).
- After a withdraw transfer request is `Failed` or `SystemFailed`, call `PrivacyPortal.cancelFailedWithdrawal(withdrawalId)` so status becomes `Failed` (no underlying release).

## How Request IDs Are Generated

The pToken calls the source inbox internally. The inbox returns a `bytes32 requestId`.

In frontend code, `writeContract` usually gives only the transaction hash, not Solidity return values. Extract request ids from events in the transaction receipt:

- Deposit: `PrivacyPortal.DepositRequested(..., mintRequestId)`.
- Withdraw: `PrivacyPortal.WithdrawalRequested(withdrawalId, ..., transferRequestId)`.
- Fee breakdown (portal vs PoD): `PrivacyPortal.OperationFeesPaid(payer, correlationId, isDeposit, isNativeWrap, portalFee, podFee, podCallbackFee, amount)`.
  - `portalFee` = protocol fee retained by the portal (native).
  - `podFee` = native forwarded to pToken/inbox.
  - `podCallbackFee` = callback slice within `podFee`.
  - `correlationId` = mint `requestId` or `withdrawalId`.
- Direct pToken action: `PodERC20.TransferRequestSubmitted(from, to, requestId)` or `ApprovalRequestSubmitted(owner, spender, requestId)`.

Do not assume request ids can be predicted client-side.

## Fee Calculation

Every pToken request needs ETH/source-chain native fee.

Use pToken:

```solidity
estimateFee() returns (uint256 totalFeeWei, uint256 targetFeeWei, uint256 callbackFeeWei)
```

Use:

- `totalFeeWei` as the PoD fee forwarded in the same portal tx.
- `callbackFeeWei` as the callback-fee argument.

Portal protocol fees are separate. Use portal views:

```solidity
estimateDepositFees(amount) -> (portalFee, usedDynamicPricing, mintTotalFee, mintCallbackFee)
estimateWithdrawFees(amount) -> (portalFee, usedDynamicPricing, transferTotalFee, transferCallbackFee)
estimateBatchBurnFees(amount) -> (burnTotalFee, burnCallbackFee)  // keeper/admin only
```

### USD oracle (PoDPriceOracle + live adapter)

Inbox and portal factory share one `PoDPriceOracle` per chain, registered with a live adapter (`BandLiveOracle` or `ChainlinkLiveOracle`):

| Consumer | Price source | When |
|----------|--------------|------|
| **Inbox** | Cached `localTokenPriceUSD` / `remoteTokenPriceUSD` | Fee validation reads cache; `refreshCache()` refreshes via registered adapter (interval-gated) |
| **Portal** | **Live** via `configuredOracle.readPrice` | Every deposit/withdraw with `percentageBps > 0` via `oracle.getLivePrices(native, collateral)` |

Configuration (`deployConfig.chains[chainId].oracle`):

- **`adapter`:** `"band"` \| `"chainlink"` \| `"plain"` — which live adapter to deploy (`plain` = manual `PriceOracle` only).
- **`liveAdapter`:** deployed adapter address (optional; filled by deploy CLI).
- **`feeds`:** per-key feed config on the adapter (`inboxLocal`, `inboxRemote`, `collateral.USDC`, …). `inboxLocal` is the local gas token (inbox cache + portal native fees).
- **`pegUsd`** on a collateral entry → `setCollateralPriceUSD` on `PoDPriceOracle` (e.g. USDC $1).
- **`consumers.inbox` / `consumers.privacyPortalFactory`:** optional oracle address overrides (default: `priceOracle`).

- **Keeper (inbox only):** `oracle.refreshCache()` — portal does **not** need keeper sync.
- **User portal txs:** one live `getLivePrices` call per fee validation.

Live upgrade: deploy new adapter + `PoDPriceOracle`, seed feeds, `inbox.setPriceOracle` + `factory.setPriceOracle`.

Deposit (one pToken mint + portal fee):

- ERC20: `deposit(recipient, amount, portalFee, mintCallbackFee)` with `value = mintTotalFee + portalFee`. User must `approve` the portal first.
- Native-wrapped (WETH/WAVAX): `depositNative(recipient, amount, portalFee, mintCallbackFee)` with `value = amount + mintTotalFee + portalFee`. No separate wrap tx.

Check `nativeWrappedUnderlying()` to pick the deposit path.

Withdraw (one pToken transfer + portal fee; **no inline burn**):

- `requestWithdrawWithPermit(recipient, amount, portalFee, transferFee, transferCallbackFee, permit...)` with `value = transferTotalFee + portalFee`.
- After release, pTokens stay in portal custody until the portal owner runs `burnAccumulatedPTokens(amount, burnCallbackFee)` with `value = burnTotalFee` (separate keeper tx).

Native-wrapped portals release **wrapped ERC20** (WETH/WAVAX) on withdraw; they do not unwrap to native coin in the portal.

## PrivacyPortal

Reads:

- `underlyingToken() -> address`
- `pToken() -> address`
- `decimals() -> uint8`
- `nativeWrappedUnderlying() -> bool`
- `withdrawalNonce() -> uint256`
- `burnDebtAmount() -> uint256`
- `withdrawals(bytes32 id) -> Withdrawal`

Writes:

- `deposit(address recipient, uint256 amount, uint256 mintCallbackFee) payable -> bytes32 requestId`
- `depositNative(address recipient, uint256 amount, uint256 mintCallbackFee) payable -> bytes32 requestId` — only when `nativeWrappedUnderlying`; wraps `amount` via WETH/WAVAX `deposit()`, then mints pTokens.
- `requestWithdrawWithPermit(address recipient, uint256 amount, uint256 transferFee, uint256 transferCallbackFee, uint256 burnFee, uint256 burnCallbackFee, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) payable -> (bytes32 withdrawalId, bytes32 transferRequestId)`

Withdraw release: when `nativeWrappedUnderlying`, the portal calls `underlying.withdraw(amount)` and sends native coin to the recipient; otherwise it transfers the ERC20.

Events:

- `DepositRequested(user, recipient, amount, mintRequestId)`
- `WithdrawalRequested(withdrawalId, user, recipient, amount, transferRequestId)`
- `WithdrawalReleased(withdrawalId, recipient, amount)`
- `BurnSubmitted(withdrawalId, amount, burnRequestId)`
- `BurnDebtRecorded(withdrawalId, amount, reason)`

## pToken / PodERC20

Reads:

- `name()`, `symbol()`, `decimals()`
- `balanceOfWithStatus(account) -> (ctUint256 balance, bool pending)`
- `allowanceWithStatus(owner, spender) -> (Allowance, bool pending)`
- `failedRequests(requestId) -> bytes`
- `estimateFee() -> (totalFeeWei, targetFeeWei, callbackFeeWei)`
- `nonces(owner) -> uint256`
- `publicTransferPermitDomainSeparator() -> bytes32`

Writes commonly used by UI:

- Direct public amount transfer: `transfer(address to, uint256 amount, uint256 callbackFee) payable`
- Direct public amount approve: `approve(address spender, uint256 amount, uint256 callbackFee) payable`
- Direct public amount burn: `burn(uint256 amount, uint256 callbackFee) payable`
- Portal withdraw path: `transferFromAndCallWithPermit(...)` is called by `PrivacyPortal`, not directly by the UI.

Events:

- `TransferRequestSubmitted(from, to, requestId)`
- `ApprovalRequestSubmitted(owner, spender, requestId)`
- `Transfer(from, to, senderValue, receiverValue)`
- `TransferFailed(from, to, errorMsg)`
- `Approval(owner, spender, ownerValue, spenderValue)`
- `ApprovalFailed(owner, spender, errorMsg)`
- `RequestCallbackFailed(from, to, requestId, callbackData)`

## Permit For Withdrawal

Permit is verified on the ETH/PoD pToken. It authorizes the portal to transfer plaintext `amount` pTokens from the user to the portal as part of withdrawal.

Typed data domain:

```ts
{
  name: await pToken.read.name(),
  version: "1",
  chainId: sourceChainId,
  verifyingContract: pTokenAddress
}
```

Types:

```ts
{
  TransferPermit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
}
```

Message:

```ts
{
  owner: userAddress,
  spender: portalAddress,
  to: portalAddress,
  value: amount,
  nonce: await pToken.read.nonces([userAddress]),
  deadline
}
```

The portal is both `spender` and `to`.

## Minimal ABIs

Prefer generated ABIs if available. If the UI has no contract package, use these fragments.

```ts
export const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }
] as const;
```

```ts
export const privacyPortalAbi = [
  { type: "function", name: "underlyingToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "burnDebtAmount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "withdrawals", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [
    { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
    { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }
  ] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [
    { type: "address" }, { type: "uint256" }, { type: "uint256" }
  ], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "requestWithdrawWithPermit", stateMutability: "payable", inputs: [
    { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint8" },
    { type: "bytes32" }, { type: "bytes32" }
  ], outputs: [{ type: "bytes32" }, { type: "bytes32" }] },
  { type: "event", name: "DepositRequested", inputs: [
    { name: "user", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "mintRequestId", type: "bytes32", indexed: true }
  ] },
  { type: "event", name: "WithdrawalRequested", inputs: [
    { name: "withdrawalId", type: "bytes32", indexed: true },
    { name: "user", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "transferRequestId", type: "bytes32", indexed: false }
  ] },
  { type: "event", name: "WithdrawalReleased", inputs: [
    { name: "withdrawalId", type: "bytes32", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false }
  ] },
  { type: "event", name: "BurnDebtRecorded", inputs: [
    { name: "withdrawalId", type: "bytes32", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "reason", type: "bytes", indexed: false }
  ] }
] as const;
```

```ts
export const podPTokenAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "failedRequests", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes" }] },
  { type: "function", name: "estimateFee", stateMutability: "view", inputs: [], outputs: [
    { name: "totalFeeWei", type: "uint256" },
    { name: "targetFeeWei", type: "uint256" },
    { name: "callbackFeeWei", type: "uint256" }
  ] },
  { type: "function", name: "balanceOfWithStatus", stateMutability: "view", inputs: [{ type: "address" }], outputs: [
    { type: "tuple", components: [
      { name: "high", type: "tuple", components: [{ name: "high", type: "uint256" }, { name: "low", type: "uint256" }] },
      { name: "low", type: "tuple", components: [{ name: "high", type: "uint256" }, { name: "low", type: "uint256" }] }
    ] },
    { type: "bool" }
  ] },
  { type: "event", name: "TransferRequestSubmitted", inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "requestId", type: "bytes32", indexed: false }
  ] },
  { type: "event", name: "TransferFailed", inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "errorMsg", type: "bytes", indexed: false }
  ] },
  { type: "event", name: "Transfer", inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "senderValue", type: "bytes", indexed: false },
    { name: "receiverValue", type: "bytes", indexed: false }
  ] }
] as const;
```
