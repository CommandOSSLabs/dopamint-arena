# rustbench Richer Metrics + Varied Gameplay + Container — Design

**Status:** Approved (brainstorm), pending implementation plan
**Date:** 2026-06-26
**Builds on:** Plan 3 (swarm fleet + resources + report) and the `--fresh-keys`
addition. All under `tools/rustbench/`.
**Parent spec:** `docs/superpowers/specs/2026-06-26-rustbench-swarm-fleet-design.md`

## Goal

Make rustbench report the same depth of statistics loadbench does (and more),
measure the engine honestly (game-loop time separated from per-match setup), and
run correctly under a CPU-pinned container — so a rustbench-vs-loadbench
comparison is apples-to-apples on harness, measurement, and environment.

Concretely, add: per-game match/tunnel counts, a moves-per-match distribution,
dual throughput (wall-clock vs play-only), per-match play-loop duration
percentiles, CPU utilization percentiles with a cgroup-aware denominator,
thread count, fresh-keys-by-default harness parity, and a container image.

**Success criteria:**

1. `rustbench --offchain --channel local --game blackjack` defaults to **fresh
   keys per match** and **varied gameplay**, and prints the richer report.
2. The byte-exact golden gate (`fixed_match_matches_ts_golden`) and the
   deterministic fleet-total tests still pass, run under `--deterministic`.
3. Inside `docker run --cpus N`, the reported CPU utilization is measured against
   N assigned cores (cgroup), not the host core count.

**Non-goals:** relay channel, on-chain anchor, multi-game `--game all` table
(still deferred); streaming/approximate percentile estimators (data is small —
exact sort is used).

## Global invariants

- All work under `tools/rustbench/` plus a `Dockerfile`. No changes to
  `backend/`, `sui-tunnel-ts/`, `frontend/`, `tools/loadbench/`.
- The **signed/verified protocol path is unchanged**: every move is still
  co-signed and both signatures verified; settlement is co-signed and verified.
- `--deterministic` reproduces the exact Plan 2 golden match byte-for-byte. The
  parity gate is the guard that varied gameplay did not perturb the fixed path.
- CPU-bound fleet stays on rayon threads; no async/tokio.
- Each task ends `cargo clippy -p rustbench -- -D warnings` clean and
  `cargo fmt -p rustbench` applied. Conventional Commits, no AI attribution.

## Metrics (what the report contains)

Per-game block (one game today — blackjack):

- **tunnels opened** — matches that entered the play loop.
- **tunnels settled** — matches that produced a co-signed settlement.
- **matches conducted** — settled count. In this synchronous build
  `opened == settled` (the deadline is checked *before* a match is claimed, so a
  worker never starts a match it cannot finish); both are reported and the report
  notes they are equal by construction. The two counters are kept distinct so a
  future mid-match-abandon mode reads correctly.
- **moves per match** — `avg, p50, p90, p99, peak, min, count`.

Throughput. The fleet measures, per match, both `total_ns` (setup + play) and
`play_ns` (play loop only). From the merged samples:

- **wall move-TPS** (aggregate) = `total_moves * 1000 / wall_elapsed_ms` —
  includes per-match setup (keygen, tunnel construction); directly comparable to
  loadbench's swarm TPS. This is the headline.
- **setup overhead %** = `(Σ total_ns − Σ play_ns) / Σ total_ns * 100` — the
  share of busy time spent on setup rather than the game loop. With `--fresh-keys`
  this is where keygen shows up.
- **play-only move-TPS** (aggregate, setup-free) = `wall_TPS * Σ total_ns /
  Σ play_ns` — wall TPS rescaled so setup is free. Same aggregate scale as wall
  TPS and always `≥ wall_TPS`. The pure-engine aggregate ceiling.
- **play-loop duration per match** — `avg, p50, p90, p99, peak` (nanoseconds,
  rendered in µs/ms). The unambiguous per-match engine cost (independent of fleet
  scale).

CPU:

- **threads** — fleet worker count (rayon `num_threads`).
- **cores used** — process CPU-time / wall: `avg, peak`.
- **utilization %** — against the assigned-core denominator: `avg, p50, p99,
  peak`.
- **cgroup basis** — whether the denominator came from a cgroup quota or the host
  core count.

Memory:

- **RSS** — `avg, p50, peak` (MB).

## Component design

### Varied gameplay + determinism (`game/blackjack.rs`, `driver.rs`)

`draw_rank` gains an optional per-match seed:

```
fn draw_rank(match_seed: Option<u64>, round: u64, draw_index: u64) -> u8
```

- `None` → `blake2b(DOMAIN ‖ u64be(round))` — byte-identical to today (the
  golden / deterministic path).
- `Some(s)` → `blake2b(DOMAIN ‖ u64be(s) ‖ u64be(round))` — varied cards per
  match.

The seed threads through `deal_round`/`draw_to` to `draw_rank`. The driver entry
points (`play_fixed_match`, `play_prepared`) take a `card_seed: Option<u64>`. The
fleet passes `Some(match_index)` in varied mode and `None` in deterministic mode.
Varied matches still terminate (round cap + `max_moves`) and remain fully
co-signed/verified; only card values, hence move counts, state hashes, and
signatures, differ between matches.

### Play-only timing (`driver.rs`)

`play_fixed_match`/`play_prepared` perform **setup** (key expansion/generation +
`DistTunnel::new` ×2) outside a timer, then time only `play_loop`:

```
let t = Instant::now();
let result = play_loop(&mut dt_a, &mut dt_b, tunnel_id, created_at, max_moves);
let play_ns = t.elapsed().as_nanos();
```

`MatchResult` gains `play_ns: u128` (play loop only). The fleet closure times the
whole match (setup + play) as `total_ns`. Setup — including `--fresh-keys`
generation — is the `total_ns − play_ns` difference: excluded from `play_ns` and
from the play-only figures, still counted in wall TPS. This is how "only count
when the game loop starts" is enforced.

### Fleet sample collection (`fleet/swarm.rs`)

The per-match closure returns `MatchSample { moves: u64, bytes: u64, play_ns:
u128, total_ns: u128 }` (the closure brackets setup + play for `total_ns`; the
driver supplies `play_ns`). `run_with` gives each worker a **local
`Vec<MatchSample>`** (no per-match atomic contention) and merges them after the
rayon scope. The stop/claim logic (atomic claim index, deadline, matches cap) is
unchanged. Aggregates and exact percentiles are computed from the merged set. At
~200k matches × ~32 B the buffer is a few MB — negligible.

`SwarmOutcome` grows: counters `tunnels_opened`, `tunnels_settled`,
`matches_conducted`; totals `moves_total`, `bytes_total`, `play_ns_total`,
`total_ns_total`, `wall_ms`; and **pre-summarized** `moves_dist: Distribution`,
`play_ns_dist: Distribution` (computed inside `run_with` after merge — the raw
per-match vectors are not retained on the struct). Runners: `run_fresh_keys`
(default), `run_simple` (fixed keys), `run_optimized` (cached fixed keys); each
takes a `card_seed_mode` (varied/deterministic) parameter.

### Distribution helper (`fleet/stats.rs`)

A small reusable summarizer:

```
pub struct Distribution { pub count, pub avg, pub p50, pub p90, pub p99,
                          pub min, pub peak }
pub fn summarize<T: Into<f64> + Copy>(xs: &[T]) -> Distribution
```

Exact percentiles via sort (nearest-rank). Reused for moves-per-match,
play-loop-duration, CPU utilization, and RSS.

### Resource sampler + cgroup (`fleet/resources.rs`, `fleet/cgroup.rs`)

`resources.rs` stores per-sample vectors (cores, utilization %, RSS) and returns
distributions at `stop`. It also records the thread count it was told.

`fleet/cgroup.rs` provides the assigned-core denominator and container CPU time:

- **Linux**: read `/sys/fs/cgroup/cpu.max` (v2: `"<quota> <period>"`/`"max"`) or
  `cpu.cfs_quota_us` + `cpu.cfs_period_us` (v1) for assigned cores;
  `cpu.stat usage_usec` (v2) / `cpuacct.usage` (v1) for cgroup CPU time. Mirrors
  loadbench's `resourceMonitor.ts` (`parseCgroupV2Quota`, `readCgroupCpuUsec`).
- **Other (macOS dev)**: fall back to `available_parallelism` for the
  denominator and process CPU-time for utilization; `basis = "system"`.

`cpu_budget() -> { cores, basis }` is the single source of the denominator, so
utilization is correct both bare-metal and under `docker run --cpus N`.

### CLI (`cli.rs`)

- `--fixed-keys` (flag; default off) → **fresh keys per match is the default**.
  Internally `fresh_keys = !fixed_keys`.
- `--deterministic` (flag; default off) → varied gameplay is the default.
- Existing `--runner simple|optimized|both` retained; optimized is the opt-in
  cached-key comparison. `--workers`, `--duration`, `--matches` unchanged.

### Report (`report.rs`)

Renders the metric blocks above, keeping the `[local/offchain]` line prefix.
Existing golden report tests are updated to the new shape; numeric formatting is
golden-string tested. Deterministic-mode renders fixed values (moves dist all
143) so a parity render is byte-stable.

### Container (`Dockerfile`)

Multi-stage: build `cargo build -p rustbench --release` on a Rust image, copy the
binary into a slim Debian runtime. Documented usage:

```
docker build -t rustbench -f tools/rustbench/Dockerfile .
docker run --cpus 8 --memory 2g rustbench --offchain --channel local --game blackjack
```

cgroup-aware accounting (above) makes the in-container CPU report correct.

## Testing

- **Parity gate unchanged**: `fixed_match_matches_ts_golden` passes (deterministic
  path, `card_seed = None`).
- **Deterministic fleet totals**: `--deterministic --workers 1 --matches N`
  ⇒ `143*N` moves, `75982*N` bytes, `N` tunnels (run under deterministic mode).
- **Varied gameplay**: a varied run produces a non-degenerate moves-per-match
  distribution (peak > min) and still conserves balances per match.
- **Play-only timing**: `play_ns > 0` and `play_ns ≤ total_ns` per match; the
  derived play-only aggregate TPS ≥ wall TPS, and setup overhead % is in `[0,100)`.
  With `--fresh-keys` the overhead is visibly higher than with `--fixed-keys`.
- **Distribution helper**: unit tests for percentile correctness on known inputs.
- **cgroup parsing**: unit tests for v2 (`"800000 1000000"` → 0.8 cores,
  `"max ..."` → none) and v1 quota/period, plus the macOS fallback path.
- **Report**: golden-string tests for the new lines in deterministic mode.

## Out of scope / follow-on

- Relay channel, on-chain anchor, `--game all` multi-game markdown table.
- Per-move (not per-match) latency timestamps.
- Approximate percentile estimators (only needed if sample volume grows orders of
  magnitude).
