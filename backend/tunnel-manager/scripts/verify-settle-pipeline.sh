#!/usr/bin/env bash
# Verify the async settlement pipeline (ADR-0029) end-to-end, with no live fullnode or Redis.
#
# It exercises the whole solution deterministically (every core is node/Docker-free):
#   - governed RPC: transient/rejected taxonomy, AIMD limiter, backoff honoring Retry-After
#   - batched-close PTB builder (K closes -> one close_cooperative_with_root PTB, gas x K)
#   - retry-by-split: a poison settlement is isolated, not allowed to sink its batch-mates
#   - durable-queue contract (in-memory impl)
#   - /settle ingest -> 202 + enqueue (no node RPC on the request path)
#   - worker pool: idempotency (dedup + closed re-check), dead-letter, transient re-queue
#   - E2E: 200 settlements through the real /settle handler into a 4-worker pool, asserting
#     batching happened, the transient one was retried to success, and the poison one isolated.
#
# Docker/testnet-gated checks run in CI, not here: RedisSettleQueue roundtrip (testcontainers),
# the store::redis + mp::ws container tests, and the on-chain `execute` against testnet.
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
PKG=(-p tunnel-manager --bin tunnel-manager)

echo "==> build"
cargo build "${PKG[@]}" >/dev/null

echo "==> clippy (any warning fails)"
cargo clippy -p tunnel-manager --all-targets -- -D warnings >/dev/null
echo "    clippy: clean"

# Each entry: "label::filter[:::extra cargo-test args]". Filters select only pipeline tests, so
# the unrelated Docker-gated suites (store::redis, mp::ws containers) are never touched.
declare -a CHECKS=(
  "governed RPC (taxonomy + AIMD + backoff)|sui_rpc"
  "batched-close PTB builder|build_close_batch"
  "retry-by-split (poison isolation + depth cap)|settle_batch"
  "durable-queue contract|settle_queue:::--skip redis"
  "/settle ingest -> 202|settle_enqueues"
  "worker pool + E2E burst|settle_worker"
)

fail=0
for entry in "${CHECKS[@]}"; do
  label="${entry%%|*}"; rest="${entry#*|}"
  filter="${rest%%:::*}"; extra="${rest#*:::}"; [ "$extra" = "$rest" ] && extra=""
  echo "==> ${label}"
  # shellcheck disable=SC2086
  out="$(cargo test "${PKG[@]}" "$filter" -- $extra 2>&1 || true)"
  echo "$out" | grep -E "test result:" | sed 's/^/    /'
  echo "$out" | grep -q "FAILED" && { echo "    ^ FAILED"; fail=1; }
done

echo
if [ "$fail" -ne 0 ]; then echo "==> RESULT: FAIL"; exit 1; fi
echo "==> RESULT: PASS — pipeline ORCHESTRATION verified (handler -> queue -> worker pool):"
echo "    coalescing, retry-by-split isolation, transient re-queue, idempotency, 202 ingest."
echo "    (Headline e2e: settle_worker::tests::e2e_burst_through_handler_settles_with_batching_retry_and_isolation)"
echo
echo "==> NOT verified here (chain submission goes through a fake settler in tests):"
echo "    the on-chain batched close_cooperative_with_root PTB executing on testnet, and the"
echo "    real-load 429 elimination. K=128 is within testnet protocol limits (1024 cmds /"
echo "    2048 input objects / 128KB tx), but the remaining ACCEPTANCE TEST is a funded"
echo "    sui_dryRunTransactionBlock of a small batch + a fleet bench run on dev."
