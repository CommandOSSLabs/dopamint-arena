# rustbench — Rust blackjack throughput ceiling

**Date:** 2026-06-25
**Status:** Design approved, pending implementation plan

## Goal

Two outcomes:

1. **Throughput ceiling** — learn the maximum achievable off-chain move-TPS for
   blackjack on this hardware, as a hard target the TS `loadbench` path is
   measured against.
2. **Faster bot fleet** — a Rust fleet that drives far more concurrent matches
   per core than the TS `worker_threads` swarm.

The Rust bench is a **byte-compatible** port of the `loadbench` path: same wire
format, same engine semantics, supporting the **full matrix** — both channels
(`local`, `relay`) and both anchors (`offchain`, `onchain`) — but **only the
blackjack game** in this first build. Other games are out of scope here.

## Why byte-compatible

The value of the existing TS bench is that it drives the *real shipped* protocol
(byte-identical to the games and to the Move settlement). A meaningful ceiling
must do the same per-move work — BCS serialization, blake2b hashing, ed25519
sign + verify, state-root fold, commit-reveal shuffle — and must produce a
settlement root the real `close_cooperative_with_root` accepts. Anything less
measures a different, easier problem.

## Approach: hybrid (C)

A new independent crate. Port the **engine hot path fresh** (small,
perf-critical, must be byte-exact — full control, zero abstraction overhead).
**Mirror** `tunnel-manager::mp::protocol` for the relay client and **crib**
`tunnel-manager::sui` patterns for on-chain — copied, not shared, so the bench
stays independently tunable and never destabilizes the production relay.

Rejected: (A) duplicate everything → drift on integration surfaces; (B) share
backend code → refactors a shipping service for a benchmark, couples the bench
to its release cadence.

## Parity surface (the port target)

From `sui-tunnel-ts/src/core/`:

- **`wire.ts`** — `serializeStateUpdate`, `serializeSettlement`,
  `serializeSettlementWithRoot`, `serializeHtlcLock`; domain separators
  (`DOMAIN_STATE_UPDATE`, `DOMAIN_SETTLEMENT`, `DOMAIN_SETTLEMENT_V2`,
  `DOMAIN_HTLC_LOCK`); big-endian u64 helpers; `addressToBytes32`.
- **`commitment.ts`** — `computeCommitment`, `verifyCommitment`,
  `combineReveals`, `DOMAIN_COMMIT_REVEAL`, blake2b length-prefixed hashing.
- **crypto** — ed25519 sign/verify.
- **`protocol/blackjack.ts`** — the blackjack move sequence (state updates).

**Parity oracle already exists:** `golden.gen.ts` (TS) and the hex literals in
`sui_tunnel/tests/wire_format_tests.move` + `signature_tests.move` encode the
same golden bytes.

## Crate layout

New crate `tools/rustbench`, added to root workspace `members`.

```
tools/rustbench/
  src/
    engine/
      wire.rs          # StateUpdate/Settlement/HtlcLock serializers, domain seps, be-u64
      commitment.rs    # blake2b length-prefixed hash, commit-reveal
      crypto.rs        # ed25519 sign/verify (sui-crypto), keypair cache
      tunnel.rs        # per-move loop: build -> serialize -> hash -> sign -> verify -> fold root
    game/
      blackjack.rs     # move sequence ported from protocol/blackjack.ts
    channel/
      local.rs         # in-memory transport pair
      relay.rs         # WS client mirroring tunnel-manager::mp::protocol
    anchor/
      offchain.rs      # synthetic tunnel id
      onchain.rs       # create_and_fund open + close_cooperative_with_root settle
    fleet/
      swarm.rs         # multi-core fleet (aggregate-TPS mode)
      latency.rs       # per-game open->play->settle, p50/p99
      resources.rs     # CPU + RSS sampling
    report.rs          # table + markdown, format-parity with loadbench
    cli.rs  main.rs
  tests/
    vectors/*.json     # vendored TS/Move golden vectors
    golden.rs          # byte-identity assertions
```

Dependencies: workspace `bcs`, `sui-crypto`, `tokio`, `reqwest`,
`sui-transaction-builder`; plus `ed25519-dalek`, `blake2`, `rayon`, `clap`,
`core_affinity`.

## Parity strategy (three-way)

1. **Vendored golden vectors** — capture `golden.gen.ts` output + the Move test
   hex literals into `tests/vectors/*.json`; assert Rust produces byte-identical
   output for each serializer, commitment, and signature. **Nothing proceeds
   until this is green.**
2. **rust-vs-ts cross-check** — run one blackjack match through both engines;
   assert per-move signed bytes and final settlement root match.
3. **Move test reuse** — the Rust settlement root must verify under the same
   `close_cooperative_with_root` the TS path settles with (fully covered once
   the on-chain anchor lands).

Blackjack correctness is implied once engine bytes match and the settlement root
verifies — the game port only needs to emit the same *sequence* of state
updates.

## Fleet & throughput model

Two execution modes, picked by workload (mirrors loadbench's cpu/io split):

- **CPU path** (`--offchain --channel local`): cores are the bottleneck. A
  `rayon` pool, one worker per core, each running a tight **synchronous** match
  loop — no async overhead, no per-move heap allocation. Each worker owns
  reusable scratch buffers (one `Vec<u8>` BCS frame reused per move) and a cached
  expanded ed25519 secret key. **This configuration produces the ceiling.**
- **IO path** (`--channel relay` or `--onchain`): latency-bound on WS / RPC. A
  `tokio` multi-thread runtime with N in-flight matches per core (the
  `--concurrency` analog) so an awaiting match doesn't stall a core.

Throughput levers:

1. **Allocation-free hot loop** — reuse frame buffers; blake2/ed25519 write into
   caller buffers.
2. **Batch verification** — `ed25519-dalek::verify_batch` over a window of moves
   where the protocol allows deferring the counterparty check; behind a flag so
   the strict per-move-verify ceiling is also measurable.
3. **Key caching** — expand secret keys once per worker.
4. **Sharded RNG** — per-worker seedable RNG for the shuffle commit-reveal; no
   shared state, no locks.
5. **Optional core pinning** (`--pin`) via `core_affinity` to cut scheduler
   jitter on the ceiling run.

**Resource accounting** matches loadbench: CPU (busy/total via `/proc` or cgroup
when containerized) + RSS sampled every 500 ms, avg/peak reported — so the
`resources:` line and CPU-utilization column are directly comparable.

Headline deliverable: `rustbench --offchain --channel local --game blackjack` vs
`bun run bench --offchain --channel local --game blackjack` → the Rust/TS
throughput multiple = the ceiling.

## Channels & anchors

- **local** — in-memory transport pair (engine/signing ceiling).
- **relay** — WS client mirroring `tunnel-manager::mp::protocol` envelope shapes;
  drives the real `tunnel-manager` relay.
- **offchain** — synthetic tunnel id, pure move loop, no chain.
- **onchain** — crib `tunnel-manager::sui`: PTB `create_and_fund` open +
  `close_cooperative_with_root` settle on the Sui localnet, via
  `sui-transaction-builder` + JSON-RPC over `reqwest`.

## Infra reuse

Reads the **same `tools/loadbench/.env.local`** (RPC URL, package id, relay URL,
funded keys). `bun run stack` stays the single source of infra — no second
stack. The container CPU/RSS accounting path mirrors loadbench's cgroup-accurate
mode.

## Build mechanics

```bash
cargo build -p rustbench --release
cargo run   -p rustbench --release -- --offchain --channel local --game blackjack --duration 10
cargo test  -p rustbench           # golden parity + unit tests
```

Always benchmark the `--release` binary (inherits workspace
`lto = "thin"`, `codegen-units = 1`); a debug build's crypto is meaningless as a
ceiling.

## Build order (parity-first; each step a runnable checkpoint)

1. **Engine core + golden tests** — `wire.rs`, `commitment.rs`, `crypto.rs`;
   vectors green on byte-identity. Gate for everything downstream.
2. **Blackjack moves + offchain + local + single-match driver** — one match
   end-to-end; cross-check settlement root vs TS engine.
3. **Swarm fleet (rayon CPU path) + resources + report** — first ceiling TPS.
4. **Latency mode** (p50/p99) — small addition on the same driver.
5. **Relay channel** (tokio IO path, mirror `mp::protocol`).
6. **On-chain anchor** (crib `sui.rs`: PTB open + settle) — full matrix complete
   for blackjack.

Steps 1–4 need zero infra. Steps 5–6 need `bun run stack`.

## Out of scope (this spec)

- Games other than blackjack.
- Refactoring `tunnel-manager` or `backend/shared`.
- Replacing the TS `loadbench` (the two coexist; Rust establishes the ceiling).
- Shipping Rust into the frontend/production engine.

## Testing

- **Unit/golden** (`cargo test`, no infra): byte-identity vs vendored vectors;
  blackjack move-sequence shape; allocation-free-loop invariants.
- **Cross-language** (opt-in): rust-vs-ts single-match signed-bytes + root match.
- **End-to-end** (needs stack): on-chain open → play → cooperative settle on the
  localnet; relay-served match against a live `tunnel-manager`.
