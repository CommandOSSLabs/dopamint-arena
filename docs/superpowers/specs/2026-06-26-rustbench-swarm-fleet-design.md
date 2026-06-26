# rustbench Swarm Fleet + Resources + Report (Plan 3) — Design

**Status:** Approved (brainstorm), pending implementation plan
**Date:** 2026-06-26
**Builds on:** Plan 1 (engine core) and Plan 2 (blackjack protocol, frame codec,
distributed tunnel, local-channel match driver, whole-match parity gate). All
under `tools/rustbench/`.
**Parent spec:** `docs/superpowers/specs/2026-06-25-rustbench-blackjack-design.md`
(this is the "Build order step 3 — swarm fleet + resources + report" deliverable).

## Goal

A `rustbench` **binary** that runs a multi-core fleet of off-chain blackjack
matches and prints an aggregate move-TPS ceiling plus a resources line,
**format-compatible** with the TS loadbench swarm output. The headline number is
the throughput multiple of:

```
rustbench --offchain --channel local --game blackjack
```

versus

```
bun run bench --offchain --channel local --game blackjack
```

run on the same machine. That multiple is the off-chain throughput ceiling for
blackjack.

**Success criteria:**

1. The literal `--offchain --channel local --game blackjack` command line parses
   and runs.
2. Output lines match the loadbench swarm shape (fleet / swarm / tunnels settled
   / aggregate move-TPS / resources) so the two runs are directly comparable.
3. The reported TPS is honest and reproducible: it reuses the gate-verified match
   path, and per-worker counts are deterministic under `--workers 1 --matches N`.

**Non-goals (later plans):** per-match latency p50/p99 (Plan 4), relay channel
(Plan 5), onchain anchor (Plan 6), a multi-game markdown table / `--game all`
(rustbench has only blackjack today), and core pinning (`--pin`).

## Why these tool choices

- **Workload is CPU-bound, not IO-bound.** `play_fixed_match` does blake2b
  hashing, ed25519 sign/verify, and serialization in a tight synchronous loop —
  it never awaits. So the fleet is OS threads saturating cores, not an async
  runtime. `tokio` is deliberately reserved for the IO-bound relay (Plan 5) and
  onchain (Plan 6) paths; using it here would add scheduling overhead and lower
  the measured ceiling.
- **rayon** for the thread pool (matches the parent spec). Performance is
  identical to raw `std::thread` for uniform full-match tasks (work-stealing buys
  nothing when tasks are uniform and long-lived); rayon is chosen for idiomatic
  "use all cores" pool management.
- **sysinfo** for resources — cross-platform (macOS dev + Linux/container),
  replacing the parent spec's Linux-only `/proc`/`procfs`. Cgroup limits inform
  the CPU denominator when containerized.
- **clap** for CLI parsing.

New workspace dependencies: `rayon`, `clap`, `sysinfo`. (Drops `core_affinity`
and `procfs` from the parent spec's dependency list — `--pin` deferred, `procfs`
replaced by cross-platform `sysinfo`.)

## Architecture

The crate keeps its library (engine + game + driver from Plans 1–2) and **adds a
binary**. A package may carry both a lib and a bin of the same name.

```
tools/rustbench/src/
  main.rs              # bin entry: clap parse + dispatch into the fleet
  cli.rs               # arg definitions and validation
  fleet/
    mod.rs             # fleet types + shared counters + run orchestration
    swarm.rs           # rayon fleet: simple + optimized match runners
    resources.rs       # sysinfo sampler (CPU cores/%, RSS avg/peak)
  report.rs            # format-parity console output
  (lib.rs, engine/, game/, driver.rs from Plans 1–2 are unchanged consumers)
```

Each unit has one responsibility and a narrow interface:

- **cli** — parse argv into a validated `BenchOpts`; reject out-of-scope flags
  with a clear message. No fleet logic.
- **fleet::swarm** — own the rayon pool and the worker loop; produce a
  `SwarmOutcome { moves, bytes, tunnels_settled, matches_claimed, elapsed }`.
- **fleet::resources** — a sampler started before the clock and stopped after;
  produces a `ResourceSummary { cpu_cores_avg/peak, cpu_pct_avg/peak,
  rss_avg/peak, samples }`. Knows nothing about the fleet.
- **report** — pure formatting: `(BenchOpts, SwarmOutcome, ResourceSummary) ->
  String`. No IO beyond the final `print`.

## The work unit

One **match = one tunnel** playing a full multi-round game: open → many rounds
(bet → deal → player hits/stands → dealer → cooperative settlement), the player
role rotating every two rounds, until a side cannot fund the 25-min bet. With the
golden fixed keys and 200/200 balances this is the gate-pinned 143-move game.

Each match gets a **distinct tunnel ID** derived from a per-worker counter (e.g.
`format!("0x{:x}", (worker_id as u64) << 32 | match_index)`), mirroring TS's
unique-tunnel-per-match. The card sequence is identical across matches because the
protocol derives cards from `round` only (true in TS as well); only the tunnel ID
and therefore the signed bytes/signatures differ per match.

## Fleet engine (rayon)

- A rayon pool sized to `--workers` (default `auto` = available cores).
- Long-lived workers via `rayon::scope`/`spawn`. Each worker loops:
  1. Claim the next match index (shared `AtomicU64`); if `matches` is set and the
     claim exceeds it, stop.
  2. Check the shared stop flag / deadline; if elapsed, stop.
  3. Derive the tunnel ID, run one full match.
  4. `moves.fetch_add(r.moves)`, `bytes.fetch_add(r.bytes)`,
     `tunnels_settled.fetch_add(1)` (only after the settlement is produced).
- **Stop condition:** `matches_claimed >= --matches` OR `wall >= --duration`
  (default 15s) — whichever fires first. The main thread times the run, flips the
  stop flag, and the scope end joins all workers.
- **Warm-up excluded:** build the pool and worker-local state, then start the
  clock and the resource sampler.

Shared counters are `AtomicU64`; with scoped threads they are shared by reference
(no `Arc`). A match in flight when the stop flag flips does **not** increment
`tunnels_settled`, so `tunnels_settled` ≤ `matches_claimed`.

## Staged perf path (two runners, two tasks, both numbers reported)

The parent spec lists perf levers (per-worker reused buffers + cached expanded
ed25519 keys). `play_fixed_match` currently allocates fresh tunnels and
re-expands keys per call. This plan implements both, staged:

- **Task A — first ceiling (simple runner):** the fleet calls the existing,
  gate-verified `play_fixed_match`, varying only the tunnel ID. Honest and
  reproducible; some per-match allocation and key re-expansion.
- **Task B — optimized runner:** a worker-local runner that caches the two
  expanded ed25519 signing keys per worker and reuses scratch `Vec<u8>` frame
  buffers across matches, minimizing heap churn. Must produce **byte-identical
  results** to the simple runner for the same tunnel ID (verified in test).

The report prints **both** aggregate TPS numbers so the optimization's payoff is
explicit. If only the simple runner is selected (e.g. `--runner simple`), the
optimized figure is omitted; default runs both back-to-back over equal windows.

## Resources (cross-platform via sysinfo)

A sampler thread, started before the clock and stopped after, refreshes on a
fixed interval (≈250–500ms):

- **CPU "cores":** process CPU time over wall time (a process pegging 4 cores
  reads ≈4.0). From sysinfo per-process CPU usage summed across the sample.
- **CPU "%":** system-wide utilization; in a cgroup-capped container the
  denominator is the assigned cores, not host cores.
- **RSS:** process resident set, tracked as running avg and peak.

Produces `ResourceSummary { cpu_cores_avg, cpu_cores_peak, cpu_pct_avg,
cpu_pct_peak, rss_avg, rss_peak, samples }`. The sampler never panics the run; on
a platform where a metric is unavailable it reports 0 for that field and still
yields a sample count.

## CLI (clap)

| Flag | Meaning |
|---|---|
| `--workers N\|auto` | rayon threads; default `auto` = core count |
| `--duration S` | seconds to run; default 15 |
| `--matches N` | stop after N matches (with duration, first to fire wins) |
| `--offchain` | accepted; required anchor for this build |
| `--channel local` | accepted; required transport for this build |
| `--game blackjack` | accepted; the only game in this build |
| `--runner simple\|optimized\|both` | which runner(s) to measure; default `both` |

`--concurrency` is **removed**, not accepted: it is meaningless in the
synchronous CPU path (there is no idle-await time to interleave, unlike TS's
async worker), so passing it is rejected with a message explaining it does not
apply to rustbench. The headline `--offchain --channel local --game blackjack`
line carries no `--concurrency`, so the parity command is unaffected.

Other out-of-scope flags (`--onchain`, `--channel relay`, `--all`, `--pin`,
`--container`, `--rpc-url`, …) are likewise rejected with a clear "not supported
in this build (see Plan 4/5/6)" message rather than silently ignored.

## Output (format-parity, console only)

```
[local/offchain] fleet: workers=12
[local/offchain] swarm: 481234 moves over 3366 matches in 15.0s
[local/offchain] tunnels settled: 3366 (224.4/s)
[local/offchain] aggregate move-TPS: 32082.3   (optimized: 41120.7)
[local/offchain] resources: cpu avg=11.2 cores (93%) peak=12.0 cores (100%), rss avg=58MB peak=63MB, samples=30
```

- `move-TPS = moves * 1000 / elapsed_ms` (moves per second, matching the TS
  `ratePerSec` definition).
- `tunnels settled/s = tunnels_settled * 1000 / elapsed_ms`.
- **Which window the lines describe:** under `--runner both` (default) the two
  runners run back-to-back as two separate `--duration` windows, so total
  wall-clock is ≈ 2 × duration. The `swarm:`, `tunnels settled:`, and
  `resources:` lines report the **simple** runner's window (the honest,
  reproducible baseline); the `aggregate move-TPS` line shows the simple figure
  with the optimized figure appended in parentheses as the speedup annotation.
  Under `--runner simple` or `--runner optimized`, a single window runs and every
  line describes that one runner (no parenthetical).
- The `resources:` line uses the loadbench `formatResources` shape.

The multi-game markdown table (`--game all`) is deferred.

## Testing

- **Swarm determinism:** `--workers 1 --matches N` yields exactly
  `moves == 143 * N`, `tunnels_settled == N`, `bytes == 75982 * N`
  (the gate's per-match bytes × N). Pure, no timing dependence.
- **Runner parity:** the optimized runner produces byte-identical
  `MatchResult` (moves, bytes, settlement, sig_a, sig_b) to the simple runner for
  the same tunnel ID — reuses the Plan 2 parity discipline.
- **Report formatting:** `report::render(opts, outcome, resources)` against fixed
  inputs produces the exact expected lines (golden-string assertions).
- **Resources sampler:** runs without panicking and returns a `samples > 0`
  summary with non-negative, finite fields on the test platform.
- **CLI:** out-of-scope flags are rejected with a non-zero result and a clear
  message; the literal `--offchain --channel local --game blackjack` parses.

Heavy multi-core timing runs are not asserted in CI (non-deterministic); the
deterministic single-worker totals are the regression gate.

## Open risks

- **sysinfo CPU semantics differ by platform.** The "cores" and "%" definitions
  must be documented and validated on both macOS and Linux so the comparison
  against `bun run bench` is apples-to-apples. The sampler's mapping is the part
  most likely to need a second pass.
- **Optimized runner correctness.** Caching keys and reusing buffers must not
  change a single output byte; the runner-parity test is the gate, and any
  divergence blocks Task B (never weaken the test).

## Roadmap (unchanged, for context)

- Plan 4 — latency mode (p50/p99 per match).
- Plan 5 — relay channel (tokio IO path).
- Plan 6 — onchain anchor (PTB open + cooperative settle).
