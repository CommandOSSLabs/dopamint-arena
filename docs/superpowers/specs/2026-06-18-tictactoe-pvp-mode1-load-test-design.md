# Tic-Tac-Toe PvP Mode 1 Load Test Design

**Date:** 2026-06-18  
**Status:** Design — awaiting implementation plan  
**Goal:** Attempt to relay **1,000,000+ sustained actions/sec** through the real `tunnel-manager` WebSocket backend using tic-tac-toe PvP.

## 1. What this is and is not

This is **not** the 1M off-chain Ed25519 ops/sec benchmark. That benchmark uses blackjack self-play in a single process.

This test measures **backend relay throughput**: how many co-signed MOVE frames the backend can receive from one player and forward to the other player per second.

- **Mode 1:** Skip on-chain tunnel deposits, opens, and closes. The off-chain `DistributedTunnel` protocol is fully real.
- **PvP:** Two headless clients per match, connected through the backend relay.
- **Game:** Tic-tac-toe, because it is the existing PvP game in the frontend.

## 2. Success criterion

Achieve **1,000,000+ sustained relayed actions/sec** (MOVE frames) aggregated across all load-generator instances, for at least 30 seconds, with backend error rate < 0.1%.

If the software/infra ceiling is below 1M, the deliverable is a documented ceiling plus the bottleneck analysis.

## 3. Architecture

```
Load Generators (c7i.48xlarge × N)
  │ WebSocket
  ▼
ALB
  │
Fargate Backend Task (large single task, or few tasks)
  │ local in-memory fan-out
  │
Redis (cache.r6g.4xlarge+)
  │ presence, queues, counters, cross-instance fallback
  ▼
Other backend tasks (if horizontally scaled)
```

Key design decisions:

- **Minimize cross-instance relay**: Start with one large Fargate task so 100% of relay frames stay in local memory. Horizontal backend scaling increases cross-instance traffic through Redis pub/sub.
- **Backend hot-path optimization**: Cache opponent `ConnRef`, remove per-frame JSON parsing, batch action counters.
- **Mode 1**: No on-chain lifecycle. The off-chain protocol remains real.

## 4. Phase A: Backend relay hot-path optimizations

### 4.1 Current hot path (per relayed MOVE)

1. Receive WebSocket text frame.
2. Parse payload JSON (outer envelope).
3. Parse payload JSON again (inner frame) to detect `kind === "move"`.
4. Redis GET `match:<id>` for action counting.
5. Redis INCRBY actions counter.
6. Redis GET `match:<id>` again to resolve opponent.
7. Lookup local connection sender.
8. SPUBLISH if opponent is on another instance.

### 4.2 Optimized hot path (per relayed MOVE)

1. Receive WebSocket text frame.
2. Parse payload JSON once; cheap `kind` substring check.
3. Use cached opponent `ConnRef` from connection state.
4. Increment local action counter batch.
5. Lookup local connection sender + local `mpsc` send.
6. Flush counters to Redis every 100 ms.

### 4.3 Code changes

- `backend/tunnel-manager/src/mp/ws.rs`
  - Add `MatchRouting` struct cached per connection.
  - Optimize `relay_payload_is_move` to single parse + substring check.
  - Batch `add_actions` increments.
- `infra/src/resources/alb.ts`
  - Add stickiness cookie keyed on `matchId` (or IP-based as fallback).

## 5. Phase B: Load generator

### 5.1 Client lifecycle

1. Generate deterministic wallet + ephemeral ed25519 keypair.
2. Open WebSocket to `wss://<backend>/v1/mp`.
3. Server sends `challenge { nonce }`.
4. Client sends `connect { wallet, pubkey, sig, nonce }`.
5. Client sends `queue.join { game: "tictactoe" }`.
6. Server pairs clients → `match.found { matchId, role, opponentWallet, game }`.
7. Exchange peer `hello` over relay.
8. Build `DistributedTunnel` with `TicTacToeProtocol`.
9. Play game: A moves → B acks → B moves → A acks ...
10. After terminal state, close socket; start new match.

### 5.2 New files

- `sui-tunnel-ts/src/bench/pvpTicTacToeLoadTest.ts` — single client / pair orchestrator.
- `sui-tunnel-ts/src/bench/pvpClient.ts` — WebSocket transport + auth wrapper.
- `sui-tunnel-ts/src/bench/pvpCoordinator.ts` — multi-instance start signal + aggregation.

### 5.3 Bot behavior

- Reuse minimax/heuristic from `frontend/src/games/ticTacToe/packages/shared`.
- Each game ends in ≤9 moves, then clients immediately re-queue.
- Moves are deterministic given board state, so pairs stay synchronized.

### 5.4 Metrics

- Actions/sec (MOVE frames sent/received)
- Move round-trip latency p50/p99
- Matches completed/sec
- Errors and disconnects

## 6. Phase C: Infra scaling via Pulumi

### 6.1 Backend

- Increase Fargate task size from 1 vCPU / 2 GB to **4 vCPU / 8 GB** (or larger).
- Increase `desiredCount` from 2 to **10–20+**.
- Add target-tracking autoscaling on CPU or ALB request count.

### 6.2 Redis

- Scale pubsub replication group from `cache.t4g.medium` to **cache.r6g.4xlarge+**.
- Consider cluster mode if single-primary becomes a bottleneck.

### 6.3 Load generators

- Switch benchmark fleet to **c7i.48xlarge**.
- Increase ASG max size to **10+**.
- Move instances to public subnets to avoid NAT Gateway bandwidth charges.

### 6.4 ALB

- Raise idle timeout for long-lived WebSockets.
- Add WAF rate-based rules to prevent accidental self-DDoS.

### 6.5 Other

- Add S3 reports bucket + IAM policy for benchmark instances to upload results.

## 7. Phase D: Run the test

1. Deploy optimized backend + scaled infra via Pulumi.
2. Scale load-generator ASG to N instances.
3. Wait for all generators to be ready.
4. Coordinator broadcasts `START_AT_UNIX_MS` to all instances.
5. All generators begin playing simultaneously.
6. Each generator writes per-second metrics locally.
7. After steady state, coordinator collects and aggregates reports.
8. Compute sustained/peak actions/sec across all instances.
9. Scale/tune and rerun if target not met.

## 8. Metrics and reporting

### 8.1 Per-generator metrics

- `actions_total`
- `actions_per_second` (per-second bucket)
- `move_latency_ms` (p50, p99)
- `matches_completed_total`
- `errors_total`
- `disconnects_total`

### 8.2 Aggregated metrics

- `sustained_actions_per_second`: minimum bucket over 30s steady state.
- `peak_actions_per_second`: maximum bucket over the run.
- `total_matches_completed`
- `total_errors`

### 8.3 Backend metrics

- `backend_relay_actions_per_second`
- `backend_cpu_utilization`
- `backend_memory_utilization`
- `redis_cpu_utilization`
- `redis_pubsub_messages_per_second`
- `alb_active_connections`

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Backend hot path still too slow | Profile first; add local caching, remove JSON parse, batch counters. |
| ALB stickiness fails during scaling | Acceptable for benchmark; pairs that split fall back to Redis pub/sub. |
| Redis becomes bottleneck | Scale node type or enable cluster mode. |
| Load generators exhaust CPU/network | Scale to more instances; use c7i.48xlarge. |
| Cost exceeds ceiling | Set AWS budget alarm; use Spot for benchmark instances. |
| 1M not reachable | Document ceiling and bottleneck; do not chase indefinitely. |

## 10. Open questions

- What is the approved AWS cost ceiling for the test?
- Should the test run in `dev`, `staging`, or a dedicated stack?
- Do we need the results to be reproducible as a CI/regression test?
- Should we also measure end-to-end move latency p99 as a hard requirement?

## 11. Next step

Transition to implementation planning via `writing-plans` skill.
