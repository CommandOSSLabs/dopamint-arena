# Blackjack/Payment Self-Play Benchmark Results

**Date:** 2026-06-18  
**Hardware:** `c7i.48xlarge` benchmark instance (192 vCPU / 384 GB) in us-east-1  
**Branch:** `feat/blackjack-selfplay-benchmark`  
**Benchmark:** `sui-tunnel-ts/src/bench/cli.ts` (Deliverable 10 harness)

## Goal

Measure the actual sustained TPS of the existing off-chain blackjack/payment self-play benchmark on the most powerful single-instance hardware available in the dev stack, and compare it to the PvP relay numbers.

## What changed for this run

- Created branch `feat/blackjack-selfplay-benchmark` from `origin/dev`.
- Added `--progress-every-ms` CLI flag to `sui-tunnel-ts/src/bench/cli.ts` so peak-TPS sampling resolution is configurable.
- Passed the flag through to `sui-tunnel-ts/src/bench/harness.ts`.
- Upgraded the benchmark instance from the AMI's Node 18 to Node 22 at runtime (the harness's worker threads crash on Node 18).
- Ran the compiled `dist/bench/cli.js` to avoid tsx/worker-thread loader issues.

## Methodology

All runs used the multi-core cluster harness (`sim/cluster.ts`) with worker threads equal to `nproc - 1` (191 workers on a 192-vCPU instance). Each worker shards a subset of tunnels and runs a tight sign/verify loop. The report records:

- `avgTps`: total interactions divided by elapsed wall time.
- `peakTps`: highest sampled aggregate rate during the run.
- `signaturesPerSec` / `verificationsPerSec`: crypto throughput.
- `settlementSuccessRate`: in-process cooperative settlement sample.

## Results

### Short run (full dual-sign + verify)

```bash
node dist/bench/cli.js \
  --tunnels 10000 --updates-per-tunnel 100 \
  --workers 191 --duration 10000 --sign-mode full \
  --progress-every-ms 100
```

| Metric | Value |
|---|---|
| Elapsed | 7.76 s |
| Interactions | 1,000,000 |
| Avg TPS | **128,916** |
| Peak TPS | **1,204,150** |
| Signatures/sec | 257,832 |
| Verifications/sec | 257,832 |
| Settlement success | 100% |

### Sustained run (full dual-sign + verify)

```bash
node dist/bench/cli.js \
  --tunnels 10000 --updates-per-tunnel 1000 \
  --workers 191 --duration 30000 --sign-mode full \
  --progress-every-ms 100
```

| Metric | Value |
|---|---|
| Elapsed | 40.27 s |
| Interactions | 9,550,000 |
| Avg TPS | **237,149** |
| Peak TPS | 4,950,495 |
| Signatures/sec | 474,298 |
| Verifications/sec | 474,298 |
| Settlement success | 100% |

### Sustained run with batching (full dual-sign + verify)

```bash
node dist/bench/cli.js \
  --tunnels 10000 --updates-per-tunnel 1000 \
  --workers 191 --duration 30000 --sign-mode full \
  --batch 100 --progress-every-ms 100
```

| Metric | Value |
|---|---|
| Elapsed | 31.69 s |
| Interactions | 7,891,900 |
| Avg TPS | **249,058** |
| Peak TPS | 338,281 |
| Signatures/sec | 498,116 |
| Verifications/sec | 498,116 |
| Settlement success | 100% |

### Sustained run with batching (sign-only)

```bash
node dist/bench/cli.js \
  --tunnels 10000 --updates-per-tunnel 1000 \
  --workers 191 --duration 30000 --sign-mode sign-only \
  --batch 100 --progress-every-ms 100
```

| Metric | Value |
|---|---|
| Elapsed | 18.50 s |
| Interactions | 10,000,000 |
| Avg TPS | **540,657** |
| Peak TPS | 1,241,304 |
| Signatures/sec | 1,081,315 |
| Verifications/sec | 0 |
| Settlement success | 100% |

## Observations

- **Peak TPS can exceed 1M** on a single `c7i.48xlarge` in both full and sign-only modes, but peak is driven by the initial ramp-up sample and is not representative of steady-state throughput.
- **Sustained honest throughput (full sign + verify) is ~250,000 TPS** on one instance.
- **Sustained sign-only throughput is ~540,000 TPS** on one instance.
- The 1M sustained target is **not met** by a single instance with the honest metric, but it is within reach with **2–4 instances** in sign-only mode or roughly **4 instances** in full mode.
- Per-core throughput on the c7i is lower than on the local development machine, likely due to the workload being memory/cache-bound and the instance using hyper-threaded vCPUs (96 physical cores).

## Comparison to PvP relay

| Benchmark | Sustained TPS per `c7i.48xlarge` | Bottleneck |
|---|---|---|
| Tic-tac-toe PvP through backend relay | ~1,000 | Synchronous ACK-per-move protocol + network round-trip |
| Blackjack self-play (full sign+verify) | ~250,000 | CPU / Ed25519 sign+verify |
| Blackjack self-play (sign-only) | ~540,000 | CPU / Ed25519 signing only |

## Conclusion

The existing blackjack self-play benchmark is **2–3 orders of magnitude faster** than the PvP relay test because it removes the network round-trip. With the best single-instance hardware:

- **~250,000 sustained TPS** is realistic for the honest dual-sign metric.
- **~540,000 sustained TPS** is realistic if verification is skipped.
- **1,000,000+ sustained TPS** would require either multiple instances or dropping verification.

## Files

- Code change: `sui-tunnel-ts/src/bench/cli.ts` and `sui-tunnel-ts/src/bench/harness.ts` (`--progress-every-ms` flag).
- This report: `docs/reports/2026-06-18-blackjack-selfplay-benchmark-results.md`
