---
name: pod-sablier-payroll-ui
description: >-
  Build or upgrade hrpayroll / Sablier Instant campaign UI for PoD PayrollCampaignFacade
  on Fuji (or Sepolia). Use when implementing fund, claim, clawback, factory createCampaign,
  poolCreditedTotal polling, or when the user mentions ackPoolCredit, requestCreditPool,
  PayrollCampaignFacade, sablier-payroll-pod, or Fuji payroll fund failures.
---

# PoD Sablier Payroll Campaign UI

## When To Use

Use this skill for **campaign UI** against `PayrollCampaignFacade` + factory (not Privacy Portal deposits — that is `pod-privacy-portal`).

Triggers: fund campaign, claim / claimTo, clawback, create campaign wizard, Fuji payroll, `requestCreditPool`, old `ackPoolCredit` / MpcCore bugs.

## Architecture (iteration 08 — required)

Fuji is a **PoD client chain**: **no** code at `0x64`. Do **not** call local `MpcCore` / `ackPoolCredit` on the facade.

| Step | Fuji (UI) | COTI (relayer / inbox) |
|------|-----------|-------------------------|
| Fund | Public `pToken.transfer(facade, amount)` → settle | — |
| Credit pool | `facade.requestCreditPool(amount)` + inbox AVAX | `PrivatePayrollCoti.creditPool` → `onPoolCredited` |
| Claim | merkle / fee / `submitPayload` / `claim` | `verifyAndCredit` (+ pool deduct) |
| Payout | — | callback → `payoutTo(to, uint256)` public transfer |

Poll **`poolCreditedTotal`** after fund (not local encrypted pool / not `ackPoolCredit`).

## Deployed addresses (Fuji + COTI testnet)

Prefer app config / `pod-dapp-ports/sablier-payroll-pod/deployments/production-payroll-avalancheFuji.json`. Snapshot after pod.inbox.v2.2 redeploy (`updatedAt` 2026-07-21):

| Role | Address | Explorer |
|------|---------|----------|
| Inbox (Fuji + COTI) | `0x3b8B70819f27e0438cBcE7f31894f799da52648F` | — |
| MpcExecutor | `0x6804961167c3c8ef2bf6839ddcf51ec1fbe800c3` | Cotiscan |
| PrivatePayrollCoti | `0xd523915b48d7985837f5b10ffc6c41dc66313f04` | [Cotiscan](https://testnet.cotiscan.io/address/0xd523915b48d7985837f5b10ffc6c41dc66313f04#code) |
| PayrollVault | `0x5c8f11c891bf884a153a98535a65f37903df509c` | [Snowscan](https://testnet.snowscan.xyz/address/0x5c8f11c891bf884a153a98535a65f37903df509c#code) |
| PodClaimStore | `0x5889141489b4f4377cb575888231ebdd7f492064` | [Snowscan](https://testnet.snowscan.xyz/address/0x5889141489b4f4377cb575888231ebdd7f492064#code) |
| PayrollCampaignFactory | `0x40eca0ffc86c83bcde80504926a1dd7f8d84a25b` | [Snowscan](https://testnet.snowscan.xyz/address/0x40eca0ffc86c83bcde80504926a1dd7f8d84a25b#code) |
| Template facade | `0xd01e50071FDf432BA74552Ea0d0Cd22367461848` | [Snowscan](https://testnet.snowscan.xyz/address/0xd01e50071FDf432BA74552Ea0d0Cd22367461848#code) |
| Comptroller | `0x920189a7688b1653573916438b3c3bf566c3c03f` | Snowscan |
| pMTT | `0xFC6283a9000d7D5Cf8A058A04A9ED90265Af1634` | Snowscan |
| PrivacyPortal (pMTT) | `0xf4100d21eB4B1a66aDde58A01D1E32356F268b3F` | Snowscan |

Chain ids: Fuji `43113`, COTI testnet `7082400`. **Live fees:** quote via `inbox.calculateTwoWayFeeRequiredInLocalToken` (UI gas/size heuristics — never on-chain in PayrollVault). **UI-shaped live e2e:** `npm run test:e2e:pod-live:fuji` (encryption service + `PodRequest`, no local mine).

## UX rules

1. **Fund is two steps:** public transfer settle → `requestCreditPool` → wait `PoolCredited` / `poolCreditedTotal`.
2. **Never** call `ackPoolCredit` (removed). Never expect Fuji MPC / AccountOnboard for pool.
3. **Claim** is async: `ClaimInstant` = submitted; **Paid** only when `hasClaimed` + balance sync after dual-chain mine.
4. Quote **comptroller fee** (`calculateMinFeeWei`) **and** live inbox + pToken fees off-chain (InboxFeeManager + `pToken.estimateFee` at current `gasPrice`); pass all wei into `claim` / fund / clawback — never use on-chain vault `estimateFee` or baked fee storage.
5. Top up facade with native AVAX for claim inbox fees (claim pays inbox from facade float using a live quote).
6. Create campaigns via **`PayrollCampaignFactory.createCampaign`**; register COTI leaves after create.

## Read next

- `reference.md` — ABIs, fee fields, state machine, anti-patterns
- Port docs: `pod-dapp-ports/sablier-payroll-pod/docs/USER_FLOWS.md` — networks, contracts, inbox callbacks
- Port docs: `pod-dapp-ports/sablier-payroll-pod/docs/AIRDROP_CAMPAIGN_UI_CHECKLIST.md`
- Port docs: `pod-dapp-ports/sablier-payroll-pod/docs/ARCHITECTURE.md`
- Port docs: `pod-dapp-ports/sablier-payroll-pod/docs/iterations/ITERATION_08_GAPS.md`
