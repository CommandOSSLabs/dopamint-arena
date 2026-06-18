# Blackjack/Payment Self-Play Benchmark Results

**Date:** 2026-06-18  
**Hardware:** `c7i.48xlarge` benchmark instances (192 vCPU / 384 GB each) in us-east-1  
**Capacity:** 384 vCPU On-Demand quota → up to 2 instances  
**Branch:** `feat/blackjack-selfplay-benchmark`  
**Benchmark:** `sui-tunnel-ts/src/bench/cli.ts` (Deliverable 10 harness)

## Goal

Measure the actual sustained TPS of the existing off-chain blackjack/payment self-play benchmark on the most powerful hardware available in the dev stack, first on a single instance and then across the current AWS vCPU capacity (two `c7i.48xlarge` instances), and compare it to the PvP relay numbers.

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

## Two-instance run (current vCPU capacity)

AWS service quota for standard On-Demand instances in this account is **384 vCPUs**, which permits **two** `c7i.48xlarge` instances (192 vCPUs each). The same harness was run independently on two freshly launched benchmark instances and the results were summed. Because each instance is self-contained (no cross-instance coordination), aggregate sustained throughput is the sum of per-instance sustained throughput.

### Full dual-sign + verify (2 × c7i.48xlarge)

```bash
node dist/bench/cli.js \
  --agents 2000 --tunnels 20000 --updates-per-tunnel 1000 \
  --duration 10000 --sign-mode full --batch 100 --progress-every-ms 100
```

| Instance | Elapsed | Interactions | Avg TPS | Peak TPS | Signatures/sec | Verifications/sec |
|---|---:|---:|---:|---:|---:|---:|
| i-0ebf724075bb94a91 | 11.86 s | 2,620,200 | 220,983 | 308,000 | 441,967 | 441,967 |
| i-00fe5d749dd1f73e2 | 11.84 s | 2,589,300 | 218,746 | 876,364 | 437,493 | 437,493 |
| **Aggregate** | ~11.85 s | **5,209,500** | **439,729** | — | **879,460** | **879,460** |

### Sign-only (2 × c7i.48xlarge)

```bash
node dist/bench/cli.js \
  --agents 2000 --tunnels 20000 --updates-per-tunnel 1000 \
  --duration 10000 --sign-mode sign-only --batch 100 --progress-every-ms 100
```

| Instance | Elapsed | Interactions | Avg TPS | Peak TPS | Signatures/sec |
|---|---:|---:|---:|---:|---:|
| i-0ebf724075bb94a91 | 12.15 s | 5,841,100 | 480,749 | 1,670,000 | 961,498 |
| i-00fe5d749dd1f73e2 | 12.28 s | 5,982,700 | 487,072 | 1,164,356 | 974,143 |
| **Aggregate** | ~12.22 s | **11,823,800** | **967,821** | — | **1,935,641** |

## Observations

- **Peak TPS can exceed 1M** on a single `c7i.48xlarge` in both full and sign-only modes, but peak is driven by the initial ramp-up sample and is not representative of steady-state throughput.
- **Sustained honest throughput (full sign + verify) is ~250,000 TPS per instance** and **~440,000 TPS across the current two-instance capacity**.
- **Sustained sign-only throughput is ~540,000 TPS per instance** and **~968,000 TPS across the current two-instance capacity**, just under the 1M sustained target.
- The 1M sustained target is **not met** with the honest full-sign metric at current capacity, but is **within reach in sign-only mode** and would require roughly **two more instances** in full-sign mode.
- Per-core throughput on the c7i is lower than on the local development machine, likely due to the workload being memory/cache-bound and the instance using hyper-threaded vCPUs (96 physical cores).

## Comparison to PvP relay

| Benchmark | Sustained TPS per `c7i.48xlarge` | Sustained TPS at current capacity (2 instances) | Bottleneck |
|---|---:|---:|---|
| Tic-tac-toe PvP through backend relay | ~1,000 | ~1,000 | Synchronous ACK-per-move protocol + network round-trip |
| Blackjack self-play (full sign+verify) | ~250,000 | ~440,000 | CPU / Ed25519 sign+verify |
| Blackjack self-play (sign-only) | ~540,000 | ~968,000 | CPU / Ed25519 signing only |

## Conclusion

The existing blackjack self-play benchmark is **2–3 orders of magnitude faster** than the PvP relay test because it removes the network round-trip. With the best available hardware in this account:

- **~250,000 sustained TPS** is realistic per `c7i.48xlarge` for the honest dual-sign metric.
- **~540,000 sustained TPS** is realistic per instance if verification is skipped.
- At the current two-instance capacity, the honest metric reaches **~440,000 sustained TPS** and sign-only reaches **~968,000 sustained TPS**.
- **1,000,000+ sustained TPS** is achievable in sign-only mode with a small quota increase, and in full-sign mode with roughly four `c7i.48xlarge` instances.

## Files

- Code change: `sui-tunnel-ts/src/bench/cli.ts` and `sui-tunnel-ts/src/bench/harness.ts` (`--progress-every-ms` flag).
- This report: `docs/reports/2026-06-18-blackjack-selfplay-benchmark-results.md`
