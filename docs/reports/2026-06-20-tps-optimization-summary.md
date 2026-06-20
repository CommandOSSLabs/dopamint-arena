# Off-chain TPS optimization summary

**Date:** 2026-06-20  
**Branch:** `feat/offchain-tps-bench`

## What changed

We identified that the original single-process benchmark was **worker-thread saturated**, not hardware saturated. A single Node process with 128 workers left ~64 of 192 vCPUs idle.

By running **4 independent Node processes per instance** (48 workers / 250 tunnels each), we saturated all vCPUs and raised throughput.

## Results

| Configuration | Fleet TPS | Per-instance TPS | CPU utilization |
|---|---|---|---|
| Single process, 128 workers × 1000 tunnels | ~507,000 | ~253,000 | ~67.5% |
| **4 processes × 48 workers × 250 tunnels** | **~637,000** | **~318,000** | **~99.5%** |

**Improvement:** ~26% higher fleet TPS.

## Final 120-second telemetry (4×48 configuration)

| Metric | Instance A | Instance B |
|---|---|---|
| TPS | 317,737 | 319,488 |
| Signatures/sec | 635,474 | 638,976 |
| Verifies/sec | 635,474 | 638,976 |
| Total interactions | 38,432,572 | 38,642,351 |
| All-CPU average | 99.4% | 99.6% |
| All-CPU maximum | 99.9% | 99.9% |
| Samples > 90% CPU | 119 / 120 | 119 / 120 |
| Cores avg > 80% | 192 / 192 | 192 / 192 |
| Max memory used | 13.4 GiB | 12.3 GiB |
| I/O wait / steal | ~0% | ~0% |

## Takeaway

The `c7i.48xlarge` hardware is now fully utilized. The remaining limit is ed25519 sign/verify throughput, not CPU scheduling.

**Updated 5M TPS estimate:** ~16 instances (down from 22).

## References

- Full report: `docs/reports/2026-06-20-offchain-tps-benchmark-run.md`
- Runbook: `docs/runbooks/offchain-tps-benchmark.md`
- Raw telemetry on instances:
  - `/tmp/multi_proc_bench_20260620_075541/` (Instance A)
  - `/tmp/multi_proc_bench_20260620_075542/` (Instance B)
