# 0029 — Asynchronous queued settlement with batched PTB submission

- **Status**: Proposed
- **Date**: 2026-07-01

## Context

The settler is a **single controlled writer** emitting a bursty, append-only stream of
cooperative-close txs to one rate-limited Sui fullnode. Each `/settle` fires **4 serial
JSON-RPC calls** (`getObject` → `getLatestSuiSystemState` → `dryRunTransactionBlock` →
`executeTransactionBlock`); up to 32 run concurrently and two other consumers
(`SuiArenaOpener`, wallet pool) share the same node. Under `fleet_bench` — which settles
every match on-chain — this is a thundering herd: the public testnet fullnode returns **429**,
and the backend flattens *every* `submit_close` error into a terminal **422** (`routes.rs`),
so a transient rate-limit reaches the driver as a non-retryable rejection and the settle is
lost.

On-chain settle volume is governed by `S = steps per tunnel`:
`settle_rate = off-chain_TPS / S`. At fleet scale (toward 1M off-chain TPS) even the
*settle* rate is large, and the per-settle RPC cost × concurrency is what trips the node —
not on-chain capacity. ADR-0020 already frames on-chain settle as the low-volume
*provenance* layer; the fix must make that layer absorb bursts without the chain becoming a
synchronous bottleneck.

## Decision

We make settlement **asynchronous and batched**. `/settle` validates the settlement
structurally and **enqueues it to a durable Redis stream**, returning **202 Accepted** with
no node RPC on the request path. A **settle-worker pool** drains the stream
(consumer-group, at-least-once + ack), **coalesces up to K closes into one Programmable
Transaction Block** (`close_cooperative_with_root` is `public` and seat sigs are call
*arguments*, so the settler is the sole signer + SIP-58 gas payer for many independent
settlements), dry-runs and executes it once, and on failure **retries by splitting** the
batch to isolate a poison settlement (mirroring the open-batch precedent, ADR-0019). All
node traffic — settle, opener, wallet pool — flows through one **governed RPC layer** with
**adaptive concurrency (AIMD) + exponential backoff + jitter honoring `Retry-After`**.
Confirmation is the existing `explorer:proofs` event (and the chain indexer as backstop),
not the HTTP response. We **stay on the public fullnode** and live under its ceiling by
**raising S** (settling less often) plus large batches, not by adding a dedicated node.

## Consequences

- **Throughput** per node rises ~250× (4 RPC/settle → ~2 RPC per batch of 128 ≈
  0.016/settle); a 1000-settle burst becomes ~16 RPC and lands in ~1–2s instead of a 429
  storm. The HTTP request returns in ~ms; time-to-finality grows by at most the empty-queue
  poll (~100ms) versus the old synchronous path.
- **Backpressure is explicit**: node saturation becomes queue depth (a watchable metric and
  the alarm to raise S), never client failure. The request path absorbs arbitrary bursts.
- **Error taxonomy**: transient (429/5xx/timeout) is retried inside the worker and never
  reaches the client; genuine rejection (bad sig / already-closed / balance mismatch) goes to
  a dead-letter + failed-settlement event. Structural rejects still return 422 synchronously
  at ingest (no RPC needed).
- **Idempotency is required**: at-least-once delivery + crash recovery mean a tunnel must
  settle at most once on-chain. Dedup by `tunnel_id` + closed-registry re-check at build
  time; treat *already-closed-on-chain* as success (emit the proof, ack); the indexer makes
  provenance eventually consistent if a worker dies before publishing. A multi-tunnel PTB
  uses a per-batch nonce (like `sponsor_nonce`) for the SIP-58 `ValidDuring` replay guard.
- **The driver fires-and-forgets** (awaits only the 202), removing the herd at the source;
  `party_driver` asserts only locally-known `final_balances`, so it needs no inline digest.
- We remove the settle-specific 32-concurrency layer (ingest is now O(1); the worker pool +
  governed RPC layer are the real bounds).
- We explicitly do **not** add a dedicated/multi-node RPC (the node stays the hard throughput
  ceiling, mitigated by S), and do **not** build a synchronous `?wait=true` confirm path
  unless an interactive UI needs the inline digest. The cooperative settle's authorization is
  the co-signed bytes (ADR-0007), so async acceptance does not weaken trust.
