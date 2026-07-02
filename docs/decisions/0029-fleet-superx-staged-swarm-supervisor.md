# 0029 — Fork fleet-bench into a staged-swarm supervisor (fleet-superx)

- **Status**: Accepted
- **Date**: 2026-07-02

## Context

`fleet-bench` maximizes steady-state throughput: it keeps a fixed pool of tunnel
lifecycles full, refilling as tunnels close, and never coordinates phases across
tunnels. That is the wrong shape for load-shape testing a **network** anchor,
where we need to reproduce a fleet's *arrival pattern* — many tunnels opening
together, then playing, then settling together — across many machines/processes
at once, under live observation and graceful control.

The reusable machinery for this lives inside `fleet-bench`, but the pieces we
need (`pre_open_gate`, `settle_wave_gate`, `report`/`resources`/`heartbeat`,
`swarm.rs` pipeline control flow) are `pub(crate)` in private modules and cannot
be imported. `fleet-bench` is also the untouchable throughput baseline: changing
it to grow supervisor/staging concerns would risk its numbers and its role as a
regression anchor. Two reasonable people could either (a) generalize
`fleet-bench` in place, or (b) stand up a separate binary.

## Decision

We ship a **new** `fleet-superx` crate: a single binary that is both a supervisor
daemon and its CLI client, managing concurrent named runs; each run spawns N
staged swarms (a hidden `run-swarm` subcommand of the same binary). Each swarm
runs a **staged open → play → settle** pipeline with per-swarm barriers.

- **Reuse by dependency where the surface is public** (engine + protocol crates);
  **reuse by copy-and-adapt** for the `pub(crate)` bench modules — copied into
  `src/swarm/`, promoted to `pub`, logic unchanged. `fleet-bench` is not modified.
- **Staging lives at the `TunnelAnchor` seam**, not in a forked `PartyDriver`: a
  `StagingAnchor` drives the open barrier (`PreOpenGate`) and a `SettleManager`
  drives the settle barrier + two-seat pairing + batched drain. We never
  reimplement the driver.
- **Barriers are per-swarm** (a swarm stages only its own tunnels); tunnel-id
  uniqueness across swarms and concurrent runs is namespaced by folding the
  `run_id` and `global_index = swarm_index + local_index * swarm_count` into the
  id, so nothing collides cross-process.
- **`fleet-serve` is kept**, not renamed: `fleet-bench` depends on
  `fleet_serve::HeartbeatPayload`, so the two crates coexist as workspace members.

## Consequences

- We can model arrival shape independently of on-chain packing: **Layer 1**
  cohorts (`--open-cohort`/`--settle-cohort` = pipeline concurrency cap +
  spacing) compose with, but are distinct from, **Layer 2** Sui PTB batch size
  (`--sui-open-batch`/`--sui-settle-batch`). Only Layer 1 applies to the memory
  anchor.
- The copy-and-adapt seam means bench modules can drift from their superx twins;
  re-syncing improvements is a manual diff, accepted as the price of not touching
  the throughput baseline.
- Determinism is *internal* (golden = fixed seed → constant moves/tunnel), **not**
  parity with `fleet-bench`'s exact numbers — we deliberately do not reuse bench's
  private strategy (see ADR-0018 for per-game seed determinism).
- Graceful stop is structural: `stop` = SIGTERM → each swarm drains its current
  phase, so there are never half-open tunnels; the daemon lands the run in
  `Finished` with a merged aggregate.
- A disjoint per-swarm Sui account/gas pool (`daemon --accounts-file`) is required
  so concurrent sponsored opens never contend on shared coins — a live-node
  concern, unit-tested via allocation/release logic and exercised manually.
