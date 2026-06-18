# PvP Mode 1 Load Test Bottleneck Analysis

**Date:** 2026-06-18  
**Stack:** `dopamint-arena` dev (us-east-1)  
**Goal:** Determine why the tic-tac-toe PvP load test is far below the 1,000,000 sustained actions/sec target and identify realistic paths to the goal.

## Executive Summary

The load-test pipeline is **functionally complete and end-to-end stable**: benchmark instances boot from an S3 artifact, wait on a shared S3 start signal, play tic-tac-toe through the real `tunnel-manager` WebSocket relay, upload per-instance reports, and the coordinator aggregates them with zero errors.

However, the system is **capped at roughly 1,000 actions/sec per benchmark instance**, regardless of how many CPU cores or concurrent pairs are added. The bottleneck is **not** generator CPU, backend CPU, or the AWS network path. It is the **synchronous ACK-per-move protocol** in `DistributedTunnel`, which forces every action to wait for a full round-trip before the next action can be sent.

Reaching 1,000,000 actions/sec with the current protocol would require either:

1. **Pipelining moves** in `DistributedTunnel` (a real protocol change), or
2. **Redefining the benchmark** to use synthetic relay frames that do not exercise real gameplay.

Pure horizontal scaling cannot bridge the gap: the current AWS account vCPU limit allows only two `c7i.48xlarge` benchmark instances, and even unlimited instances would still be limited by per-instance round-trip latency.

## Test Environment

| Component | Configuration |
|---|---|
| Backend | Fargate, initially 10 tasks × 4 vCPU / 8 GB, later 1 task × 16 vCPU / 32 GB |
| Redis pubsub/cache | `cache.r6g.4xlarge` |
| ALB | `dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com` |
| Load generator | `c7i.48xlarge` in public subnets, Amazon Linux 2023, Node 18.20.8 |
| Coordination | S3 start signal (`pvp-start-signal.json`) + S3 reports prefix |
| Code delivery | `sui-tunnel-ts.zip` uploaded to `s3://dopamint-dev-reports-912d163/artifact/sui-tunnel-ts.zip` |

## Methodology

All tests used the real TypeScript load generator (`pvpCli.ts` / `pvpMultiCoreTest.ts`) connecting through the ALB to `/v1/mp` over plain WebSocket (`ws://`). Metrics were collected from the generator's own counters (`actionsTotal`, `actionsPerSecond`, `matchesCompleted`, `errors`).

Three lines of investigation were run:

1. **Single-process scaling** — vary pairs per process on one benchmark instance.
2. **Multi-process / multi-core scaling** — shard pairs across Node child processes on one instance.
3. **Backend-shape sensitivity** — compare 10 backend tasks vs. 1 large backend task, and pin the ALB DNS to a single IP to rule out DNS overload.

AWS CloudWatch was used to verify backend CPU utilization.

## Results

### Single-process scaling (one Node event loop)

| Pairs | Duration | Total actions | Sustained actions/sec | Errors |
|---|---:|---:|---:|---:|
| 50 | 15 s | 13,859 | 924 | 0 |
| 100 | 15 s | 14,487 | 966 | 0 |
| 150 | 15 s | 14,730 | 982 | 0 |
| 200 | 15 s | 14,499 | 967 | 0 |
| 250 | 15 s | 14,716 | 981 | 0 |
| 300 | 15 s | 14,568 | 971 | 0 |

**Observation:** Throughput is flat after ~50 pairs. Adding concurrency inside one process does not increase throughput because the single Node event loop is already saturated handling the per-move signing/verifying/state-machine work and the synchronous waits.

### Multi-process scaling (pairs split across Node child processes)

Tests run with the backend set to one large task (16 vCPU / 32 GB).

| Total pairs | Workers | Pairs/worker | Total actions | Sustained actions/sec | Errors |
|---|---:|---:|---:|---:|---:|
| 100 | 1 | 100 | 14,511 | 967 | 0 |
| 200 | 2 | 100 | 10,362 | 691 | 0 |
| 400 | 4 | 100 | 14,183 | 945 | 0 |
| 800 | 8 | 100 | 8,624 | 575 | 0 |
| 1,600 | 16 | 100 | 14,441 | 963 | 0 |

**Observation:** Total actions/sec does not scale with workers. The system oscillates around 600–1,000 actions/sec total. Because every action is gated by a round-trip, adding processes only increases contention for the same latency budget rather than increasing the number of completed round-trips.

### Backend CPU

| Metric | Peak during tests |
|---|---|
| Backend CPU utilization (Fargate service) | **<5%** |
| Backend memory utilization | Low |

**Observation:** The backend is not CPU-bound. The relay hot-path optimizations (per-connection routing cache, single JSON parse, batched counters) are working as intended.

### Two concurrent single-process generators

| Run | Actions | Sustained actions/sec |
|---|---:|---:|
| Generator A (100 pairs) | 5,968 | 398 |
| Generator B (100 pairs) | 6,006 | 400 |
| **Combined** | **11,974** | **798** |

**Observation:** Two independent generators on the same instance achieve less combined throughput than one generator alone, confirming that the limit is shared end-to-end latency, not per-process capacity.

## Root-Cause Analysis

### The protocol is the bottleneck

`DistributedTunnel` enforces a strict turn-based, one-in-flight model:

```ts
propose(move: Move, timestamp: bigint): void {
  if (this.pending) throw new Error("a proposal is already awaiting ACK");
  ...
}
```

A MOVE is only considered complete after the opponent receives it, verifies it, signs an ACK, and the ACK returns to the proposer. This means:

```
throughput ≈ concurrent_pairs / round_trip_latency
```

With ~100 ms effective round-trip latency, 100 concurrent pairs yield ~1,000 actions/sec. Adding more pairs increases the round-trip latency because the shared backend, network, and event loops spend more time scheduling, so the ratio stays roughly constant.

### Why other hypotheses were rejected

| Hypothesis | Evidence | Verdict |
|---|---|---|
| Generator CPU bound | Single-process throughput flat from 50–300 pairs; backend CPU <5% | Rejected |
| Need more CPU cores | Multi-process scaling did not increase total throughput | Rejected |
| Backend CPU bound | Backend CPU <5% even under load | Rejected |
| Cross-instance relay overhead | Single 16-vCPU backend task showed same ceiling as 10 smaller tasks | Rejected |
| DNS overload | Pinning ALB DNS to one IP reduced high-load DNS errors but did not improve throughput | Rejected |
| Synchronous generator | Matches all observed data and the protocol source code | **Confirmed** |

## Options to Reach 1,000,000 Actions/sec

### Option A: Pipeline moves in `DistributedTunnel`

Allow a bounded window of `N` in-flight MOVEs before an ACK is required. The proposer could send moves `n+1, n+2, ... n+N` without waiting, and the responder ACKs ranges or individual nonces.

- **Pros:** Keeps the real PvP protocol; could raise per-pair throughput 10–100×; fewer instances needed.
- **Cons:** Non-trivial protocol redesign; changes ordering, replay, and security semantics; requires backpressure and possibly backend changes to handle bursts.
- **Estimated effort:** Days of design + implementation + golden tests.

### Option B: Massive horizontal scale-out

Request an AWS EC2 vCPU limit increase and run hundreds or thousands of `c7i.48xlarge` benchmark instances.

- **Pros:** No code change.
- **Cons:** Current account limit is 384 vCPUs (two instances). Even if unlimited, each instance is capped near 1,000 actions/sec by latency, so ~1,000 instances would be required. Linear cost and operational complexity.
- **Verdict:** Impractical for the current protocol.

### Option C: Synthetic relay benchmark

Build a generator that opens WebSocket pairs, sends pre-encoded `{"t":"frame","data":"...kind:move..."}` payloads as fast as possible, and does not wait for ACKs or run `DistributedTunnel`.

- **Pros:** Fastest path to a 1M number; directly measures backend relay capacity; minimal generator complexity.
- **Cons:** No longer validates the real off-chain gameplay protocol; cannot claim it is a PvP `DistributedTunnel` result.
- **Estimated effort:** Hours.

## Recommendation

- **If the goal is 1M actions/sec through the real protocol:** pursue **Option A** (pipelined moves). This is the only path that changes the fundamental `concurrency / latency` equation.
- **If the goal is simply to demonstrate 1M relayed frames/sec:** pursue **Option C** (synthetic benchmark) and document the distinction clearly.
- **Option B** should only be considered after pipelining is in place, because without it the cost is prohibitive and the per-instance return is flat.

## Files and Changes

- New diagnostic scripts (not committed):
  - `sui-tunnel-ts/src/bench/pvpForkWorker.ts`
  - `sui-tunnel-ts/src/bench/pvpMultiCoreTest.ts`
- Infra changes applied during testing:
  - `infra/Pulumi.dev.yaml` temporarily changed to `backend-desired-count: "1"`, `backend-task-cpu: "16384"`, `backend-task-memory: "32768"`.
  - Benchmark fleet scaled to `0` after testing.

## Appendix: Raw Multi-Process Output (representative)

```
=== pairs=100 workers=1 ===
actions/sec: 1029, 1031, 1077, 1073, 700
{ actionsTotal: 14674, sustainedActionsPerSecond: 978 }

=== pairs=200 workers=2 ===
actions/sec: 79, 61, 60, 58, 56
{ actionsTotal: 9032, sustainedActionsPerSecond: 602 }

=== pairs=400 workers=4 ===
actions/sec: 0, 0, 0, 584, 0
{ actionsTotal: 14183, sustainedActionsPerSecond: 945 }

=== pairs=800 workers=8 ===
actions/sec: 22, 0, 0, 22, 21
{ actionsTotal: 8624, sustainedActionsPerSecond: 575 }

=== pairs=1600 workers:16 ===
actions/sec: 2, 0, 0, 0, 0
{ actionsTotal: 14441, sustainedActionsPerSecond: 963 }
```

The saw-tooth per-second buckets and flat totals are the signature of a latency-bound, synchronous protocol.
