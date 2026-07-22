#!/usr/bin/env bash
# Mirror sibling repos into contracts/ for Hardhat (single source root; imports use .. across pod/inbox).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="${ROOT}/contracts"
INBOX="${ROOT}/../coti-pod-inbox-contracts/contracts"
POD="${ROOT}/../coti-contracts/contracts/pod"
MPC_SRC="${ROOT}/../pod-mpc-lib/contracts/utils/mpc"
# COTI-side executor + test harness live in pod-mpc-lib (not coti-contracts).
EXECUTOR_SRC="${ROOT}/../pod-mpc-lib/contracts/mpc/coti-side"
SIM_COTI_SRC="${ROOT}/../sim-coti-node/contracts"

if [[ ! -d "$INBOX" || ! -d "$POD" ]]; then
  echo "error: clone coti-pod-inbox-contracts and coti-contracts as siblings" >&2
  exit 1
fi

rm -rf "$CONTRACTS"
mkdir -p "$CONTRACTS"

# Inbox implementation at contracts/ root
rsync -a \
  --exclude 'utils/' \
  "$INBOX/" "$CONTRACTS/"

# Pod dApps under contracts/pod/ (interfaces + PoD-side apps; no Inbox/MpcExecutor impls)
rsync -a "$POD/" "$CONTRACTS/pod/"

# MpcCore (shared; prefer pod-mpc-lib vendored copy for ^0.8.20)
mkdir -p "$CONTRACTS/utils/mpc"
if [[ -d "$MPC_SRC" ]]; then
  rsync -a "$MPC_SRC/" "$CONTRACTS/utils/mpc/"
else
  rsync -a "${ROOT}/../coti-contracts/contracts/utils/mpc/" "$CONTRACTS/utils/mpc/"
fi

# MpcExecutor (+ COTI test harness): rewrite imports for contracts/pod/mpc/coti-side/
EXECUTOR_DST="${CONTRACTS}/pod/mpc/coti-side"
mkdir -p "$EXECUTOR_DST"
if [[ -d "$EXECUTOR_SRC" ]]; then
  for f in MpcExecutor.sol MpcExecutorCotiProxyInbox.sol MpcExecutorCotiTest.sol; do
    if [[ -f "${EXECUTOR_SRC}/${f}" ]]; then
      sed -e 's|import "../../utils/mpc/MpcCore.sol";|import "../../../utils/mpc/MpcCore.sol";|' \
          -e 's|import "../../InboxUser.sol";|import "../../../InboxUser.sol";|' \
          "${EXECUTOR_SRC}/${f}" > "${EXECUTOR_DST}/${f}"
    fi
  done
  echo "  executor: ${EXECUTOR_SRC} -> ${EXECUTOR_DST}"
else
  echo "warning: pod-mpc-lib coti-side not found at ${EXECUTOR_SRC}; MpcExecutor will be missing" >&2
fi

# simCoti fake MPC precompile helpers (COTI_BACKEND=sim dual-chain tests)
if [[ -d "$SIM_COTI_SRC" ]]; then
  mkdir -p "$CONTRACTS/sim-coti"
  rsync -a --exclude 'test/' "$SIM_COTI_SRC/" "$CONTRACTS/sim-coti/"
  echo "  sim-coti: ${SIM_COTI_SRC} -> ${CONTRACTS}/sim-coti"
else
  echo "warning: sim-coti-node contracts not found at ${SIM_COTI_SRC}; COTI_BACKEND=sim inject will fail" >&2
fi

echo "Mirrored contracts -> ${CONTRACTS}/"
echo "  inbox: ${INBOX}"
echo "  pod:   ${POD}"
