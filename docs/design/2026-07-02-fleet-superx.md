# fleet-superx — staged swarm supervisor

`fleet-superx` is a single binary that is both a **supervisor daemon** and its
**CLI client**. The daemon manages concurrent named runs; each run spawns N
staged swarms, and each swarm drives a **staged open → play → settle** pipeline
with per-swarm barriers and network-tunable batching. It is the load-shape
counterpart to `fleet-bench`'s steady-state throughput model (see ADR-0029 for
why it is a separate binary).

This doc is the source of truth for how the subsystem works and why. For how to
run it, see [the guide](../guide/running-a-swarm.md).

## Why staged, not steady-state

`fleet-bench` keeps a fixed pool of lifecycles full and never coordinates across
tunnels — ideal for peak throughput, wrong for reproducing a **fleet's arrival
pattern** against a network anchor. `fleet-superx` instead holds all of a swarm's
tunnels resident and moves them through phases *together*: every tunnel opens
before any plays, every tunnel plays before any settles. That makes the open and
settle waves — the moments that actually stress a sponsored on-chain anchor —
explicit and tunable.

## Process topology

```
fleet-superx daemon            supervisor: unix socket + optional ws + optional sink
  └─ run "run-7-a1b2c3"        one named run, mode-aware
       ├─ run-swarm (proc 0)   staged swarm: open→play→settle, prints a JSON SwarmReport
       ├─ run-swarm (proc 1)
       └─ …                    N swarm subprocesses of the SAME binary (hidden subcommand)
```

- The daemon spawns swarms as `fleet-superx run-swarm …` subprocesses and parses
  each one's JSON `SwarmReport` from stdout, merging them into a `RunAggregate`.
- **Spawn modes** (`start --mode`): `replicate` (per-swarm config ×N, concurrent),
  `distribute` (split the **tunnel count** across N swarms — remainder to low
  swarms; per-tunnel caps like `--moves` pass through unchanged, concurrent),
  `sequential` (per-swarm config, one swarm at a time).
- **Control plane**: newline-delimited JSON `Request`/`Response` over a Unix
  socket (local) and, when `--ws ADDR` is set, the same JSON as WebSocket text
  frames. Both transports dispatch through one `handle_request`, so they are
  byte-for-byte identical. `Watch` is the one streaming command.

## Staging at the anchor seam

The key design choice: **we never fork `PartyDriver`.** Staging is achieved by
substituting the `TunnelAnchor` each driver talks to. A swarm builds, per tunnel,
two `PartyDriver`s over an in-memory transport sharing one `DriverRunControl`,
each handed a `StagingAnchor`.

- **Open barrier** — `StagingAnchor::open()` opens via the inner anchor, then
  participates in a per-swarm `PreOpenGate(target = swarm tunnel count)`. Because
  every tunnel's `open()` blocks at `open_gate.wait()` until the gate releases,
  **play literally cannot begin until every tunnel has opened.** The barrier is
  structural, not a timing heuristic.
- **Settle barrier + drain** — `StagingAnchor::settle()` delegates to a per-swarm
  `SettleManager`. Each seat deposits its `TunnelSettleRequest` and awaits a shared
  per-tunnel result. When all `2 × tunnels` seat requests are deposited (play is
  complete), the manager drains: for each tunnel it admits through the
  `SettleWaveGate` (cohort/spacing), pairs both seats
  (`join!(settle_a, settle_b)`), and fans the single settled result back to both
  waiters. Draining is **cohort-concurrent** — a cohort of admitted tunnels
  overlaps in flight (bounded by `settle_cohort`), so a Sui PTB batch actually
  fills instead of trickling one seat-pair at a time.

`InnerAnchor` wraps the two concrete backends behind one enum —
`Memory(InMemoryAnchor)` for deterministic in-process runs and
`Sui(SuiOpenIntentAnchor)` scoped per tunnel for the sponsored path.

## Two layers of batching (they compose, they are not the same)

A recurring source of confusion, pinned down here:

| | Layer 1 — cohort | Layer 2 — PTB batch |
|---|---|---|
| Flag | `--open-cohort` / `--settle-cohort` (+ `*-spacing-ms`) | `--sui-open-batch` / `--sui-settle-batch` |
| Governs | pipeline **concurrency**: how many tunnels fly at once | on-chain **packing**: how many the Sui anchor packs into one PTB |
| Layer | anchor-agnostic (memory + sui) | Sui anchor only |
| Unset | no cap (all at once) | anchor default |

A cohort completes before the next starts (the concurrency cap — there is no
separate anchor-concurrency knob); spacing inserts an optional delay between
cohorts. For sui-sponsored, the two layers compose: cohort caps in-flight tunnels,
batch size caps PTB entries. Only Layer 1 applies to the memory anchor.

## Determinism

Gameplay is driven by a `SeededStrategy` (xorshift64\*). `golden` scenario uses a
fixed seed keyed on the **local** tunnel index, so the swarm offset never changes
per-tunnel move totals; `varied` seeds on the local index. The contract is
**internal** conservation/determinism — same params → identical totals, golden
per-tunnel moves constant — **not** parity with `fleet-bench`'s exact numbers,
because superx deliberately does not reuse bench's private strategy (ADR-0018,
ADR-0029). Tunnel ids fold `run_id` + `global_index` so concurrent runs and
swarms never collide.

## Live monitoring

While a run executes, each swarm posts **phase-aware heartbeats**
(`tunnelId/nonce/actionsDelta/windowMs/phase/phaseDone/phaseTotal`, camelCase) to
the daemon's localhost **sink**, rooted per run at `/runs/<run_id>`. The sink
folds them into a best-effort `LiveAggregate` (summed moves, latest phase,
settled high-water) keyed by run id.

`watch <run>` streams `RunEvent`s on a fixed cadence until a terminal `Ended`:
`State` on each lifecycle transition and `Aggregate` per tick. The aggregate a
tick reports is the **authoritative merged rollup once the run finishes**, else a
**best-effort projection of the live sink snapshot** while the run is still in
flight. These are two distinct code paths — a memory run can finish before its
last heartbeat flush, so tests isolate the strictly-live path with a run pinned
`Running` (no terminal aggregate) and assert a streamed `Aggregate` with
`moves > 0` can only come from the sink fold.

## Graceful stop

`stop <run>` marks the run `Stopping` and SIGTERMs each swarm pid. Each swarm's
`run-swarm` handler flips a shared stop flag; the pipeline requests a graceful
stop on the `DriverRunControl` and drains its `JoinSet` with a timeout, so every
tunnel finishes its current phase and settles — **no half-open tunnels**. The
daemon collects the drained reports, merges, and lands the run in `Finished`. A
pid that already exited yields `ESRCH`, treated as success. The run flips to
`Running` (and is thus stoppable) only once a swarm reports it has begun play with
its stop handler installed, so a `Stop` observed as `running` always reaches a
swarm that will drain.

## Sui account/gas pool

Concurrent sponsored swarms must fund opens from **non-contending** accounts.
`daemon --accounts-file` loads an `AccountPool` of `SuiAccountSlot`
(`{address, key_ref, gas_coin_ids}`). Each sui-sponsored run checks out one
disjoint slot per swarm (`allocate(swarms)`); an exhausted pool **rejects the run**
rather than overcommitting. Slots return to the pool when the run reaches
`Finished`/`Failed`. Allocation/release is unit-tested with plain values; the
live-node path is exercised manually (no live Sui node in CI).

## Module map

- `src/main.rs` — clap dispatch: `daemon | start | stop | ls | watch | run-swarm`.
- `src/daemon.rs` — unix + ws listeners, `handle_request`, run executor, `watch`.
- `src/client.rs` — `connect_and_send` over unix|ws; `start/stop/ls/watch` mains.
- `src/spawn.rs` / `src/runconfig.rs` — spawn modes, per-mode `run-swarm` argv.
- `src/registry.rs` — run registry + lifecycle state machine.
- `src/merge.rs` / `src/sink.rs` / `src/pool.rs` — aggregate, live sink, Sui pool.
- `src/swarm/` — the staged engine: `pipeline`, `anchor` (`StagingAnchor` +
  `InnerAnchor`), `settle_manager`, `gates`, `protocol`, `report`, `heartbeat`,
  and the ported `resources`/`cgroup`/`stats`.
