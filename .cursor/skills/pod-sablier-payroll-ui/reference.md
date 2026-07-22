# PoD Sablier Payroll UI — reference

Live Fuji+COTI addresses and explorer `#code` links: see `SKILL.md` (source verified 2026-07-19).

## Contracts the UI talks to (Fuji)

| Contract | Purpose |
|----------|---------|
| `PayrollCampaignFactory` | `createCampaign(admin, merkleRoot, token, start, expiration, name, minFeeUSD)` |
| `PayrollCampaignFacade` | Fund credit, claim, clawback, reads |
| `PodClaimStore` | `submitPayload(facade, index, verifyIt, proofHandle)` before claim |
| Inbox / FeeManager | `calculateTwoWayFeeRequiredInLocalToken` for payroll inbox quotes |
| pToken (`PodERC20` / pMTT) | Public `transfer(to, amount, callbackFee)` for fund + payout settle |
| `MockSablierComptroller` / comptroller | `convertUSDFeeToWei` / receive claim fee |

UI does **not** call `PrivatePayrollCoti` or `MpcExecutor` directly.
UI does **not** call `PayrollVault.estimateFee` — that helper was removed; gas/size heuristics live only in the client.

## Critical facade API

```solidity
function requestCreditPool(uint256 amount, uint256 callbackFeeWei) external payable; // admin
function poolCreditedTotal() external view returns (uint256);
function onPoolCredited(uint256 amount) external; // vault only

function claim(
  uint256 index,
  address recipient,
  bytes32[] merkleProof,
  uint256 inboxTotalFeeWei,
  uint256 inboxCallbackFeeWei,
  uint256 pTokenTotalFeeWei,
  uint256 pTokenCallbackFeeWei
) external payable;

function claimTo(
  uint256 index,
  address to,
  bytes32[] merkleProof,
  uint256 inboxTotalFeeWei,
  uint256 inboxCallbackFeeWei,
  uint256 pTokenTotalFeeWei,
  uint256 pTokenCallbackFeeWei
) external payable;
// Encrypted IT is via PodClaimStore only (no itAmount on claim)

function clawback(
  address to,
  uint256 amount,
  uint256 callbackFeeWei,
  uint256 pTokenTotalFeeWei,
  uint256 pTokenCallbackFeeWei
) external payable; // admin

function payoutTo(address to, uint256 amount, uint256 callbackFeeWei) external payable; // vault only

function hasClaimed(uint256 index) external view returns (bool);
function calculateMinFeeWei() external view returns (uint256);
```

**Removed (do not call):** `ackPoolCredit`, any local `MpcCore.*`, encrypted `payoutTo(itUint256)`, `PayrollVault.estimateFee`, stored `inboxFeeWei` / `callbackFeeWei` on facade.

## Fund sequence (employer / admin)

**Do not** stop after `pToken.transfer` — the facade balance is not the COTI pool until `requestCreditPool` completes.

```ts
// Off-chain payroll heuristics (UI/SDK only — keep in sync with measured MPC costs)
const PAYROLL_REMOTE_CALL_SIZE = 4096n;
const PAYROLL_CALLBACK_CALL_SIZE = 4096n;
const PAYROLL_REMOTE_EXEC_GAS = 6_000_000n;
const PAYROLL_CALLBACK_EXEC_GAS = 600_000n;

const gasPrice = await publicClient.getGasPrice(); // clamp ≥ inbox min (e.g. 2 gwei on Fuji)

// 1) Public fund
const [pTotal, , pCb] = await pToken.read.estimateFee({ gasPrice });
await pToken.write.transfer([facade, amount, pCb], {
  account: employer,
  value: pTotal,
  gasPrice,
});
// wait Transfer settle / syncBalances

// 2) Credit COTI encrypted pool — quote InboxFeeManager, never vault.estimateFee
const before = await facade.read.poolCreditedTotal();
const [targetFee, callbackFee] = await inbox.read.calculateTwoWayFeeRequiredInLocalToken([
  PAYROLL_REMOTE_CALL_SIZE,
  PAYROLL_CALLBACK_CALL_SIZE,
  PAYROLL_REMOTE_EXEC_GAS,
  PAYROLL_CALLBACK_EXEC_GAS,
  gasPrice,
]);
// pad ~5% for mulDiv rounding
await facade.write.requestCreditPool([amount, pad(callbackFee)], {
  account: admin,
  value: pad(targetFee) + pad(callbackFee),
  gasPrice,
});
while ((await facade.read.poolCreditedTotal()) < before + amount) {
  await sleep(2000);
}

// 3) Keep native AVAX on facade for later claim inbox fees (employer float)
```

## Claim sequence (employee)

```ts
await claimStore.write.submitPayload([facade, index, verifyIt, proofHandle], { account: claimant });

const [inboxTarget, inboxCb] = await inbox.read.calculateTwoWayFeeRequiredInLocalToken([
  PAYROLL_REMOTE_CALL_SIZE,
  PAYROLL_CALLBACK_CALL_SIZE,
  PAYROLL_REMOTE_EXEC_GAS,
  PAYROLL_CALLBACK_EXEC_GAS,
  gasPrice,
]);
const [pTokenTotal, , pTokenCb] = await pToken.read.estimateFee({ gasPrice });

// Employee pays Sablier minFee only; facade float pays inbox; vault float pays reserved pToken fees
await facade.write.claim(
  [index, claimant, proof, pad(inboxTarget) + pad(inboxCb), pad(inboxCb), pad(pTokenTotal), pad(pTokenCb)],
  { account: claimant, value: minFeeWei, gasPrice }
);

// Async: poll hasClaimed(index) + pToken balance sync
```

## Clawback (admin)

```ts
const [targetFee, callbackFee] = await inbox.read.calculateTwoWayFeeRequiredInLocalToken([...heuristics, gasPrice]);
const [pTokenTotal, , pTokenCb] = await pToken.read.estimateFee({ gasPrice });
await facade.write.clawback(
  [to, amount, pad(callbackFee), pad(pTokenTotal), pad(pTokenCb)],
  { account: admin, value: pad(targetFee) + pad(callbackFee), gasPrice }
);
```

## Create campaign

```ts
await factory.write.createCampaign(
  [admin, merkleRoot, pToken, start, expiration, name, minFeeUSD],
  { account: creator }
);
// Then register each leaf on COTI PrivatePayrollCoti + facade.registerLeaf (ops / backend)
```

## Fees to show in UI

| Fee | Source | Paid with |
|-----|--------|-----------|
| Claim protocol fee | `facade.calculateMinFeeWei()` / `minFeeUSD` | `msg.value` on `claim` → comptroller |
| Inbox two-way (credit / claim / clawback) | **Live** `inbox.calculateTwoWayFeeRequiredInLocalToken` (UI sizes/execGas × oracle × gasPrice) | AVAX `msg.value` or facade float |
| pToken transfer / callback | **Live** `pToken.estimateFee({ gasPrice })` (until PodERC20 is redesigned) | AVAX reserved at claim/clawback time |

**Anti-pattern:** baking gas/size heuristics or fee wei into PayrollVault / facade — fees and MPC costs go stale (`TargetFeeTooLow` / `CallbackFeeTooLow`).

## Anti-patterns (false greens / live breaks)

| Bad | Why |
|-----|-----|
| Hard-coded / stored PoD fees or on-chain `estimateFee` gas constants | Stale vs live gasPrice + oracle + MPC cost |
| `ackPoolCredit(it)` on Fuji | Calls `0x64`; empty on Fuji → revert ~28k gas |
| Encrypted `pToken.transfer(it)` for fund and assuming pool is credited | Transfer may settle; **pool ledger does not** without `requestCreditPool` |
| Treating `ClaimInstant` as paid | Fires before COTI verify + payout callback |
| Injecting sim `0x64` on AVAX in tests | Masks the live architecture bug |
| Calling `PrivatePayrollCoti` from the browser | Wrong chain; use inbox + relayer |

## Related skills

- `pod-privacy-portal` — treasury seed / pToken deposit via portal
- `pod-pp-fee-oracle-upgrade` — portal + oracle fee quoting
