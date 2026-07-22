# PoD Ecosystem Integration

Integration tests, deploy scripts, and a **multi-repo dev workspace** for the COTI PoD stack.

## Repositories

| Repo | Role |
|------|------|
| [coti-pod-inbox-contracts](../coti-pod-inbox-contracts) | Inbox implementation, fee manager, miner |
| [coti-contracts](../coti-contracts) | dApp contracts (`contracts/pod/`) |
| **pod-ecosystem-integration** (this repo) | E2E tests, deploy orchestration, workspace |

## Setup

Clone all repos as **siblings** under the same parent directory:

```
workspaces/
  coti-pod-inbox-contracts/
  coti-contracts/
  pod-ecosystem-integration/   ← you are here
```

```bash
npm install          # runs link:contracts via postinstall
npx hardhat compile
```

Run `npm run link:contracts` after changing sibling repos — it rsyncs inbox + pod sources into `contracts/` (required before compile).

## VS Code / Cursor workspace

Open [`pod-ecosystem.code-workspace`](./pod-ecosystem.code-workspace) for multi-root editing across all repos.

## Tests

| Command | Description |
|---------|-------------|
| `npm run test:erc7984` | ERC-7984 compat (local) |
| `npm run test:pp-system` | Privacy Portal system (`PP_SYSTEM_TESTS=1`) |
| `npm run test:pod-token` | pToken cross-chain (`POD_TOKEN_SYSTEM_TESTS=1`) |
| `npm run test:executor-coti` | COTI MPC executor |

Inbox-only tests live in **coti-pod-inbox-contracts** (`test:inbox-events`, `test:inbox-fee`, etc.).

## Deploy

Configuration: `deployConfig.json`, `PrivacyPortalConfig.json`.

```bash
npm run deploy:cli
npm run verify:deployments:config   # fees / oracles / wiring dump
npm run verify:deployments          # + MpcAdder.add round-trips (Sepolia/Fuji ↔ COTI)
```

Inbox deploy scripts: run from **coti-pod-inbox-contracts** (`deploy:inbox`, `relay`).

## Interface sync

When inbox APIs change, run from **coti-pod-inbox-contracts**:

```bash
npm run sync:interfaces -- ../coti-contracts
```

Then see `contracts/pod/SYNC_MANIFEST.json` in coti-contracts and re-run `npm run link:contracts` here.
