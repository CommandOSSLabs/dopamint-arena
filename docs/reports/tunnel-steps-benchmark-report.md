# Tunnel Steps-Per-Second Benchmark Report — Dopamint Dev Environment

**Date:** 2026-06-22  
**Benchmark hardware:** 2 × AWS `i7ie.48xlarge` instances (192 vCPU, 1.5 TiB RAM each)  
**Backend:** AWS Fargate ECS service `dopamint-dev-backend-service-cf37489`, `desiredCount=2`, task definition `dopamint-dev-backend:33`  
**Backend task size:** 4 vCPU / 8 GB  
**Bench tool:** `relayBench.js` (Bun) from `/opt/dopamint/bench`

## Terminology

The metric reported by the benchmark tool is `STEPS_PER_S`, which counts **tunnel steps per second** — i.e. off-chain game moves / state updates relayed through the Dopamint backend inside active tunnels.

This is **not** on-chain Sui transactions per second. Each `step` is one bot move sent via `proposeAndWait` through the relay backend to the opponent; it exercises the WebSocket/message relay path, not settlement.

## Objective

Find the highest sustained tunnel-step rate the bench hardware can drive through the Dopamint backend when the service is constrained to **exactly 2 running tasks**.

## Methodology

1. Scale backend ECS service to `desiredCount=2`, `runningCount=2`.
2. Increase backend task size from the default 1 vCPU / 2 GB to find the per-task sweet spot.
3. Run the `relayBench.js` load generator on both bench instances.
4. Vary two parameters:
   - Number of independent `bun relayBench.js` processes per instance (to utilize the 192 vCPUs).
   - Number of tunnels per process.
5. Sum the `STEPS_PER_S` reported by each process to get aggregate tunnel steps per second.

A single bench process was found to be client-CPU-bound, so multiple processes are required to saturate the backend.

## Results

### Single-process baseline (original 1 vCPU backend tasks)

| Tunnels / instance | Instance 1 | Instance 2 | Aggregate |
|---|---:|---:|---:|
| 100 | 452 | 452 | 904 |
| 200 | 475 | 585 | 1,060 |
| 300 | 471 | 1,803 | 2,274 |
| 400 | 460 | 459 | 919 |

*High variance and low tunnel-step rate; the 1 vCPU backend task was the bottleneck.*

### Multi-process sweep (4 vCPU backend tasks)

| Processes × tunnels / instance | Instance 1 | Instance 2 | **Aggregate tunnel steps/s** |
|---|---:|---:|---:|
| 1 × 300 | 2,158 | 851 | 3,009 |
| 4 × 100 | 1,622 | 1,403 | 3,025 |
| 8 × 100 | 2,857 | 2,936 | 5,793 |
| 16 × 100 | 5,768 | 5,773 | 11,541 |
| 32 × 50 | 11,130 | 11,058 | 22,188 |
| 48 × 50 | 14,615 | 14,616 | 29,231 |
| 64 × 50 | 15,322 | 15,158 | 30,480 |
| 96 × 25 | 14,968 | 14,981 | 29,949 |

## Conclusion

**Best sustained tunnel-step rate: ~30,000 STEPS_PER_S** (aggregate across both i7ie.48xlarge instances).

This is achieved with:

- 2 backend Fargate tasks at **4 vCPU / 8 GB** each.
- **64–96 independent bench processes per instance** (the plateau is reached around 64 processes).
- Around **1,600–2,400 active tunnels per instance** total.

Increasing backend tasks beyond 4 vCPU (tested 8 vCPU) reduced tunnel-step throughput, indicating the backend application is event-loop / single-thread bound and does not benefit from additional vCPUs per task under this workload.

## Key Findings

1. **One bench process cannot use the hardware.** A single `relayBench.js` process tops out around 1,500–3,000 tunnel steps/s, leaving most of the 192 vCPUs idle.
2. **Throughput scales with bench process count.** Aggregate tunnel-step rate rises steeply from 1 to 48 processes, then flattens between 48 and 96.
3. **The backend saturates around 30,000 steps/s.** With only 2 backend tasks, the system plateaus regardless of how many bench processes are added beyond ~64 per instance.
4. **Backend task sweet spot is 4 vCPU / 8 GB.** The default 1 vCPU task was severely bottlenecked; 8 vCPU was worse than 4 vCPU.

## Infrastructure Notes

- The backend service is currently running task definition `dopamint-dev-backend:33` (4 vCPU / 8 GB) with `desiredCount=2`.
- `infra/src/components/Backend.ts` was updated to accept `taskCpu` and `taskMemory` arguments; `infra/src/index.ts` now passes `4096` and `8192`.
- `pulumi up` was **not** executed because the preview showed unrelated deletions (indexer/explorer/database resources). The running task definition was updated manually via the AWS CLI to match the new Pulumi intent, creating temporary drift.
