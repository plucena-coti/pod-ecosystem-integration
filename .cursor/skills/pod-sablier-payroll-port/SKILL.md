# PoD Sablier Payroll Port

Port Sablier payroll user-story tests to PoD (`pod-payroll-port/`) with minimal story edits.

## When to use

- Implementing or debugging `pod-payroll-port/`
- Iterating on `PayrollCampaignFacade`, `PrivatePayrollCoti`, or `test/lib`
- After changes, run `npm run test:pod-payroll-port`

## AVAX vs COTI

| Chain | Contracts | Responsibility |
|-------|-----------|----------------|
| Hardhat (AVAX surrogate) | `PayrollCampaignFacade`, `PayrollVault`, `PodClaimStore`, `PodErc20Mintable` | Sablier API (`itUint256` amounts), pToken payout, inbox outbound |
| simCOTI | `PrivatePayrollCoti`, `PodErc20CotiMother` | Encrypted roster verify, garbled pToken state |
| Privacy Portal | **Test infra only** | Corporate treasury seed / `mint` top-ups — **payroll contracts never call portal** |

## Funding model (iteration 6)

1. **Treasury seed** — `seedCorporateTreasury(employer)` once per scenario (portal → employer pToken)
2. **Campaign fund** — employer encrypted `token.transfer(facade)` + balance sync + facade ETH (no plaintext `ackPoolCredit`)
3. **Story `mint`** — treasury top-up via portal to employer (not direct to facade)
4. **Claim payout** — encrypted `payoutTo(itUint256)` after COTI verify

## Private amounts (iteration 6)

- **API**: `claim(index, recipient, itUint256 amount, proof)` — stories still pass plaintext `amount`; `campaign-facade.ts` builds ITs
- **Registration**: `registerLeaf(index, recipient, amountCommitment)` — no `registeredAmount` on facade
- **Events**: `ClaimInstant` emits `amountCommitment`, not plaintext; `Clawback` has no amount field
- **Verify**: COTI `verifyAndCredit` compares encrypted claimed vs registered amount

## Merkle (PoD)

```
inner = keccak256(abi.encode(index, recipient, amountCommitment))
leaf  = keccak256(bytes.concat(inner))
amountCommitment = keccak256(abi.encode(ctUint256))
```

## Async claim path

1. **Fund** — treasury encrypted pToken transfer + facade ETH + balance sync
2. **Prepare** — claimant `PodClaimStore.submitPayload` with verify IT + payout IT + `proofHandle`; client may check decrypted facade balance (S22)
3. **Claim tx** — facade merkle/recipient checks → vault `requestPayout` → `ClaimInstant` (commitment only)
4. **Mine payroll** — COTI `verifyAndCredit` → vault `payoutTo(itUint256)`
5. **Mine pToken** — `mineAfterPayoutTransfer`
6. **Sync** — `tokenAdapter.syncAccount` for decrypted story balances

### IT signing

- **COTI verify**: claimant `buildVerifyItAmount` → inbox `batchProcessRequests`
- **Claim calldata**: claimant `buildClaimItAmount` → facade `claim`/`claimTo` selector (API shape; COTI enforces amount)
- **Register**: `PrivatePayrollCoti` + `registerLeaf(...)` selector
- **pToken payout / clawback**: `buildPayoutItAmount` per facade (sim-registered key)

## Test lib map

| File | Role |
|------|------|
| `portal-setup.ts` | Deploy portal + pToken; `seedCorporateTreasury`, `portalDepositTo` |
| `pod-scenario.ts` | Treasury seed, `fundFacade` via pToken transfer, facade registry |
| `pod-token-adapter.ts` | Story ERC20 API; `mint` = treasury top-up; facade transfer → encrypted fund |
| `campaign-facade.ts` | Plaintext→IT wrapper, payload + double mine, underfund pre-check |
| `pod-backend.ts` | `buildVerifyItAmount`, `buildClaimItAmount`, `buildPayoutItAmount` |
| `async.ts` | `mineAfterPayoutClaim` + `mineAfterPayoutTransfer` |

## Do not

- Edit `sablier-payroll/` (frozen Phase 1)
- Route campaign funding through Privacy Portal (treasury → pToken transfer only)

## References

- Gap reports: `pod-payroll-port/docs/iterations/ITERATION_01_GAPS.md` … `ITERATION_06_GAPS.md`
