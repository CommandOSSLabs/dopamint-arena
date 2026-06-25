# rustbench Swarm Fleet + Resources + Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `rustbench` binary that runs a multi-core fleet of off-chain blackjack matches and prints an aggregate move-TPS ceiling, tunnels-settled rate, and a cross-platform resources line — format-compatible with `bun run bench --offchain --channel local --game blackjack`.

**Architecture:** A rayon thread pool runs long-lived workers; each worker loops running full multi-round matches (via the Plan 2 driver) with a distinct tunnel ID, accumulating moves/bytes/tunnels into shared atomics until a duration-or-matches stop fires. A `sysinfo` sampler tracks CPU/RSS. A report module prints loadbench-shaped lines. Two match runners are staged — a simple one over the gate-verified `play_fixed_match`, and an optimized one caching expanded ed25519 keys per worker — and both TPS numbers are reported.

**Tech Stack:** Rust 2021 (rust-version 1.80); new deps `rayon`, `clap` (derive), `sysinfo`; builds on Plan 1–2 (`rustbench::driver::play_fixed_match`, `engine::{crypto,tunnel,wire}`, `game::blackjack`).

**Design spec:** `docs/superpowers/specs/2026-06-26-rustbench-swarm-fleet-design.md`.

## Global Constraints

- All work is under `tools/rustbench/` plus dependency additions to the root `Cargo.toml` `[workspace.dependencies]`. Do **not** touch `backend/`, `sui-tunnel-ts/`, `frontend/`, or `tools/loadbench/`.
- The crate keeps its existing library (engine + game + driver) unchanged in behavior; this plan **adds a binary** to the same package. Byte-exactness of the Plan 1–2 signed path must not change — the optimized runner (Task 6) must produce byte-identical `MatchResult`s to the simple runner.
- Workload is CPU-bound: the fleet uses **rayon threads**, never tokio/async.
- Stop condition: `matches_claimed >= --matches` OR `wall >= --duration` (default 15s), whichever fires first. `tunnels_settled` counts only fully completed matches (settlement produced), so `tunnels_settled <= matches_claimed`.
- Each match gets a **distinct tunnel ID** from the global match index: `format!("0x{:x}", match_index + 1)`. Cards are identical across matches (protocol derives them from `round`), so every match is the gate-pinned 143-move game; only the tunnel ID and signatures differ.
- Per-match constants for the fixed golden match: seats A = `0x01..0x20`, B = `0x21..0x40`; balances 200/200; `created_at = 1234567890`; `max_moves = 1000` (the game terminates at 143 moves). Per-match `bytes = 75982`, `moves = 143` (from the Plan 2 gate).
- CLI accepts the fixed `--offchain --channel local --game blackjack`. `--concurrency` is **rejected** with an explanatory message (meaningless in the synchronous CPU path). Out-of-scope flags (`--onchain`, `--channel relay`, `--all`, `--pin`, `--container`, `--rpc-url`, …) are rejected, not silently ignored.
- Report is console-only, format-parity with loadbench swarm output (the multi-game markdown table is deferred). Rates: `move-TPS = moves * 1000 / elapsed_ms`, `tunnels/s = tunnels_settled * 1000 / elapsed_ms`.
- Each task ends with `cargo clippy -p rustbench -- -D warnings` clean and `cargo fmt -p rustbench` applied. Conventional Commits, no AI attribution.

---

### Task 1: Dependencies + CLI parsing (`cli.rs`)

**Files:**
- Modify: root `Cargo.toml` (`[workspace.dependencies]`: add `rayon`, `clap`, `sysinfo`)
- Modify: `tools/rustbench/Cargo.toml` (`[dependencies]`: add the three)
- Create: `tools/rustbench/src/cli.rs`
- Modify: `tools/rustbench/src/lib.rs` (add `pub mod cli;`)
- Test: in-file `#[cfg(test)]` in `cli.rs`

**Interfaces:**
- Produces:
  - `#[derive(Clone, Copy, PartialEq, Eq, Debug)] pub enum Runner { Simple, Optimized, Both }`
  - `#[derive(Clone, Debug)] pub struct BenchOpts { pub workers: usize, pub duration_secs: u64, pub matches: Option<u64>, pub runner: Runner }`
  - `pub fn parse(args: impl IntoIterator<Item = String>) -> Result<BenchOpts, String>` — parses argv (excluding the program name), resolves `workers="auto"` to the core count, and rejects unsupported flags. Returns the error string clap/validation produced.

- [ ] **Step 1: Add deps to the root workspace**

In root `Cargo.toml`, under `[workspace.dependencies]`, add these three lines (next to the existing entries):
```toml
rayon = "1.10"
clap = { version = "4.5", features = ["derive"] }
sysinfo = "0.32"
```

- [ ] **Step 2: Add deps to the rustbench crate**

In `tools/rustbench/Cargo.toml`, under `[dependencies]`, add:
```toml
rayon = { workspace = true }
clap = { workspace = true }
sysinfo = { workspace = true }
```

- [ ] **Step 3: Write the failing tests**

Create `tools/rustbench/src/cli.rs` with ONLY this test module to start:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn parse_v(args: &[&str]) -> Result<BenchOpts, String> {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn parses_the_headline_bun_command_line() {
        let o = parse_v(&["--offchain", "--channel", "local", "--game", "blackjack"]).unwrap();
        assert_eq!(o.duration_secs, 15);
        assert_eq!(o.matches, None);
        assert_eq!(o.runner, Runner::Both);
        assert!(o.workers >= 1);
    }

    #[test]
    fn workers_auto_resolves_to_core_count() {
        let o = parse_v(&["--workers", "auto"]).unwrap();
        assert_eq!(o.workers, std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1));
    }

    #[test]
    fn explicit_workers_and_matches_and_runner() {
        let o = parse_v(&["--workers", "1", "--matches", "10", "--runner", "simple"]).unwrap();
        assert_eq!(o.workers, 1);
        assert_eq!(o.matches, Some(10));
        assert_eq!(o.runner, Runner::Simple);
    }

    #[test]
    fn concurrency_is_rejected_with_explanation() {
        let err = parse_v(&["--concurrency", "2"]).unwrap_err();
        assert!(err.contains("concurrency"), "message should name the flag: {err}");
    }

    #[test]
    fn onchain_and_relay_are_rejected() {
        assert!(parse_v(&["--onchain"]).is_err());
        assert!(parse_v(&["--channel", "relay"]).is_err());
        assert!(parse_v(&["--game", "poker"]).is_err());
    }
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cargo test -p rustbench cli`
Expected: FAIL (compile error — `parse`, `BenchOpts`, `Runner` not defined).

- [ ] **Step 5: Implement `cli.rs` above the test module**

Insert this at the TOP of `tools/rustbench/src/cli.rs` (before the `#[cfg(test)]` module):
```rust
//! Command-line surface for the swarm bench binary. Parses the loadbench-style
//! flags, resolves `--workers auto`, and rejects flags this build does not yet
//! support (relay/onchain/concurrency/…) with explanatory errors rather than
//! silently ignoring them.

use clap::Parser;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Runner {
    Simple,
    Optimized,
    Both,
}

#[derive(Clone, Debug)]
pub struct BenchOpts {
    pub workers: usize,
    pub duration_secs: u64,
    pub matches: Option<u64>,
    pub runner: Runner,
}

/// Raw clap layout. Validated and lowered into `BenchOpts` by `parse`.
#[derive(Parser, Debug)]
#[command(no_binary_name = true, disable_help_flag = false)]
struct Raw {
    #[arg(long, default_value = "auto")]
    workers: String,
    #[arg(long, default_value_t = 15)]
    duration: u64,
    #[arg(long)]
    matches: Option<u64>,
    #[arg(long, default_value = "both")]
    runner: String,
    #[arg(long)]
    offchain: bool,
    #[arg(long)]
    onchain: bool,
    #[arg(long, default_value = "local")]
    channel: String,
    #[arg(long, default_value = "blackjack")]
    game: String,
    /// Removed: meaningless in the synchronous CPU path. Present so we can
    /// reject it with a clear message instead of a generic "unexpected arg".
    #[arg(long)]
    concurrency: Option<u64>,
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<BenchOpts, String> {
    let raw = Raw::try_parse_from(args).map_err(|e| e.to_string())?;

    if raw.concurrency.is_some() {
        return Err("--concurrency is not supported: rustbench runs matches \
                    synchronously per thread, so there is no per-worker concurrency \
                    to set (drop the flag)."
            .to_string());
    }
    if raw.onchain {
        return Err("--onchain is not supported in this build (see Plan 6)".to_string());
    }
    if raw.channel != "local" {
        return Err(format!(
            "--channel {} is not supported in this build; only 'local' (see Plan 5)",
            raw.channel
        ));
    }
    if raw.game != "blackjack" {
        return Err(format!(
            "--game {} is not supported in this build; only 'blackjack'",
            raw.game
        ));
    }

    let workers = if raw.workers == "auto" {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
    } else {
        raw.workers
            .parse::<usize>()
            .map_err(|_| format!("--workers must be a positive integer or 'auto', got {}", raw.workers))?
    };
    if workers == 0 {
        return Err("--workers must be at least 1".to_string());
    }

    let runner = match raw.runner.as_str() {
        "simple" => Runner::Simple,
        "optimized" => Runner::Optimized,
        "both" => Runner::Both,
        other => return Err(format!("--runner must be simple|optimized|both, got {other}")),
    };

    Ok(BenchOpts {
        workers,
        duration_secs: raw.duration,
        matches: raw.matches,
        runner,
    })
}
```
Note: `--offchain` is accepted and ignored (it is the only supported anchor); unknown flags like `--pin`/`--rpc-url` are rejected automatically by clap as unexpected arguments.

- [ ] **Step 6: Register the module**

In `tools/rustbench/src/lib.rs`, add after `pub mod driver;`:
```rust
pub mod cli;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test -p rustbench cli`
Expected: PASS (5 tests). If clap rejects `--concurrency` before our check runs, confirm the field is declared on `Raw` (it must be, so our explanatory error wins).

- [ ] **Step 8: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench -- -D warnings
git add Cargo.toml tools/rustbench/Cargo.toml tools/rustbench/src/cli.rs tools/rustbench/src/lib.rs Cargo.lock
git commit -m "feat(rustbench): add swarm bench cli parsing"
```

---

### Task 2: Fleet engine + simple runner (`fleet/swarm.rs`)

**Files:**
- Create: `tools/rustbench/src/fleet/mod.rs`
- Create: `tools/rustbench/src/fleet/swarm.rs`
- Modify: `tools/rustbench/src/lib.rs` (add `pub mod fleet;`)
- Test: in-file `#[cfg(test)]` in `swarm.rs`

**Interfaces:**
- Consumes: `crate::driver::play_fixed_match`, `crate::cli::BenchOpts`.
- Produces (in `fleet/swarm.rs`, re-exported from `fleet/mod.rs`):
  - `#[derive(Clone, Debug)] pub struct SwarmOutcome { pub moves: u64, pub bytes: u64, pub tunnels_settled: u64, pub matches_claimed: u64, pub elapsed_ms: u128 }`
  - `pub const SEAT_A: [u8; 32]` = `0x01..0x20`, `pub const SEAT_B: [u8; 32]` = `0x21..0x40`
  - `pub fn tunnel_id_for(match_index: u64) -> String` = `format!("0x{:x}", match_index + 1)`
  - `pub fn run_simple(workers: usize, duration_secs: u64, matches: Option<u64>) -> SwarmOutcome` — runs the rayon fleet over `play_fixed_match` until the stop condition; returns aggregate counts and measured elapsed.

- [ ] **Step 1: Write the failing tests (deterministic single-worker totals)**

Create `tools/rustbench/src/fleet/swarm.rs` with this test module first:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_ids_are_distinct_and_hex() {
        assert_eq!(tunnel_id_for(0), "0x1");
        assert_eq!(tunnel_id_for(254), "0xff");
        assert_ne!(tunnel_id_for(10), tunnel_id_for(11));
    }

    #[test]
    fn single_worker_fixed_matches_are_deterministic() {
        // matches-bounded: exactly N matches => 143*N moves, 75982*N bytes, N tunnels.
        let out = run_simple(1, 3600, Some(5));
        assert_eq!(out.matches_claimed, 5);
        assert_eq!(out.tunnels_settled, 5);
        assert_eq!(out.moves, 143 * 5);
        assert_eq!(out.bytes, 75982 * 5);
    }

    #[test]
    fn multi_worker_conserves_totals() {
        // Total work is fixed by --matches regardless of worker count.
        let out = run_simple(4, 3600, Some(20));
        assert_eq!(out.matches_claimed, 20);
        assert_eq!(out.tunnels_settled, 20);
        assert_eq!(out.moves, 143 * 20);
        assert_eq!(out.bytes, 75982 * 20);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rustbench swarm`
Expected: FAIL (compile error — symbols not defined).

- [ ] **Step 3: Create `fleet/mod.rs`**

`tools/rustbench/src/fleet/mod.rs`:
```rust
//! Multi-core bench fleet: a rayon pool of long-lived workers running full
//! off-chain matches until a duration-or-matches stop, plus resource sampling.
pub mod swarm;
```

- [ ] **Step 4: Implement the fleet above the test module in `swarm.rs`**

Insert at the TOP of `tools/rustbench/src/fleet/swarm.rs`:
```rust
//! The synchronous CPU fleet. Each rayon worker claims the next match index,
//! runs one full match through the gate-verified `play_fixed_match`, and folds
//! its moves/bytes/tunnels into shared atomics until the stop condition fires.
//! Total work under `--matches N` is exact (143*N moves), which is the
//! deterministic regression gate; `--duration` is the time-bounded throughput
//! mode.

use crate::driver::play_fixed_match;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Golden seat A secret: bytes 0x01..0x20.
pub const SEAT_A: [u8; 32] = {
    let mut k = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        k[i] = (i + 1) as u8;
        i += 1;
    }
    k
};

/// Golden seat B secret: bytes 0x21..0x40.
pub const SEAT_B: [u8; 32] = {
    let mut k = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        k[i] = (i + 33) as u8;
        i += 1;
    }
    k
};

const CREATED_AT: u64 = 1234567890;
const MAX_MOVES: u64 = 1000;

#[derive(Clone, Debug)]
pub struct SwarmOutcome {
    pub moves: u64,
    pub bytes: u64,
    pub tunnels_settled: u64,
    pub matches_claimed: u64,
    pub elapsed_ms: u128,
}

/// Distinct, valid hex tunnel id per match (offset by 1 to avoid the all-zero address).
pub fn tunnel_id_for(match_index: u64) -> String {
    format!("0x{:x}", match_index + 1)
}

/// Shared, by-reference fleet state (scoped threads, no Arc).
struct Counters {
    moves: AtomicU64,
    bytes: AtomicU64,
    tunnels: AtomicU64,
    claimed: AtomicU64,
    stop: AtomicBool,
}

pub fn run_simple(workers: usize, duration_secs: u64, matches: Option<u64>) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |tunnel_id| {
        let r = play_fixed_match(&tunnel_id, &SEAT_A, &SEAT_B, 200, 200, CREATED_AT, MAX_MOVES);
        (r.moves, r.bytes as u64)
    })
}

/// Core fleet loop, generic over the per-match runner (Task 6 adds the optimized one).
/// `run_match(tunnel_id) -> (moves, bytes)`.
pub(crate) fn run_with<F>(
    workers: usize,
    duration_secs: u64,
    matches: Option<u64>,
    run_match: F,
) -> SwarmOutcome
where
    F: Fn(String) -> (u64, u64) + Sync,
{
    let counters = Counters {
        moves: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        tunnels: AtomicU64::new(0),
        claimed: AtomicU64::new(0),
        stop: AtomicBool::new(false),
    };
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()
        .expect("rayon pool");

    let start = Instant::now();
    let deadline = start + Duration::from_secs(duration_secs);

    pool.scope(|s| {
        for _ in 0..workers {
            s.spawn(|_| loop {
                if counters.stop.load(Ordering::Relaxed) {
                    break;
                }
                if Instant::now() >= deadline {
                    counters.stop.store(true, Ordering::Relaxed);
                    break;
                }
                // Claim the next match index up front; respect the matches cap.
                let idx = counters.claimed.fetch_add(1, Ordering::Relaxed);
                if let Some(cap) = matches {
                    if idx >= cap {
                        counters.stop.store(true, Ordering::Relaxed);
                        break;
                    }
                }
                let (m, b) = run_match(tunnel_id_for(idx));
                counters.moves.fetch_add(m, Ordering::Relaxed);
                counters.bytes.fetch_add(b, Ordering::Relaxed);
                counters.tunnels.fetch_add(1, Ordering::Relaxed);
            });
        }
    });

    let elapsed_ms = start.elapsed().as_millis();
    // claimed counts one over-claim per worker that observed the cap/stop; the
    // settled tunnel count is the authoritative completed-match number.
    let tunnels_settled = counters.tunnels.load(Ordering::Relaxed);
    let matches_claimed = matches
        .map(|cap| tunnels_settled.min(cap))
        .unwrap_or(tunnels_settled);
    SwarmOutcome {
        moves: counters.moves.load(Ordering::Relaxed),
        bytes: counters.bytes.load(Ordering::Relaxed),
        tunnels_settled,
        matches_claimed,
        elapsed_ms,
    }
}
```
Note on the claim/cap race: `fetch_add` hands each worker a unique `idx`; a worker that draws `idx >= cap` does no work and stops. Completed matches (`tunnels`) therefore equal exactly `min(claimed_work, cap)` — the tests assert the exact `cap`. `matches_claimed` is reported as the settled count (clamped to the cap) so the swarm line reads naturally.

- [ ] **Step 5: Register the module**

In `tools/rustbench/src/lib.rs`, add after `pub mod engine;`:
```rust
pub mod fleet;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p rustbench swarm`
Expected: PASS (3 tests). If `moves`/`bytes` totals are off, the per-match constants diverged — re-check against the Plan 2 gate (143 moves, 75982 bytes); never weaken the test.

- [ ] **Step 7: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench -- -D warnings
git add tools/rustbench/src/fleet tools/rustbench/src/lib.rs
git commit -m "feat(rustbench): rayon swarm fleet with simple runner"
```

---

### Task 3: Resource sampler (`fleet/resources.rs`)

**Files:**
- Create: `tools/rustbench/src/fleet/resources.rs`
- Modify: `tools/rustbench/src/fleet/mod.rs` (add `pub mod resources;`)
- Test: in-file `#[cfg(test)]` in `resources.rs`

**Interfaces:**
- Produces:
  - `#[derive(Clone, Debug, Default)] pub struct ResourceSummary { pub cpu_cores_avg: f64, pub cpu_cores_peak: f64, pub cpu_pct_avg: f64, pub cpu_pct_peak: f64, pub rss_avg_bytes: f64, pub rss_peak_bytes: u64, pub samples: u64 }`
  - `pub struct ResourceSampler { /* private */ }`
  - `pub fn start(interval_ms: u64) -> ResourceSampler` — spawns a background sampling thread immediately.
  - `impl ResourceSampler { pub fn stop(self) -> ResourceSummary }` — signals the thread, joins it, returns the summary.

**Note on `sysinfo`:** the `sysinfo` API changes between minor versions. This task targets `0.32`. If method names differ in the resolved version, confirm the current names with `cargo doc -p sysinfo --open` (or context7) — the concepts (per-process CPU %, global CPU %, process memory in bytes) are stable; only the spelling moves. `process.cpu_usage()` returns percent of ONE core (350.0 ⇒ 3.5 cores); `process.memory()` returns **bytes** (0.30+).

- [ ] **Step 1: Write the failing test (sane, non-panicking summary)**

Create `tools/rustbench/src/fleet/resources.rs` with the test module first:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampler_yields_a_sane_summary() {
        let sampler = start(50);
        // do a little CPU work so at least one interval elapses
        let mut acc = 0u64;
        for i in 0..50_000_000u64 {
            acc = acc.wrapping_add(i);
        }
        std::hint::black_box(acc);
        std::thread::sleep(std::time::Duration::from_millis(160));
        let s = sampler.stop();
        assert!(s.samples >= 1, "expected at least one sample");
        assert!(s.cpu_cores_avg >= 0.0 && s.cpu_cores_avg.is_finite());
        assert!(s.cpu_cores_peak >= s.cpu_cores_avg - 1e-9);
        assert!(s.rss_peak_bytes >= 1);
        assert!(s.rss_avg_bytes > 0.0);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p rustbench resources`
Expected: FAIL (compile error — `start`, `ResourceSampler`, `ResourceSummary` not defined).

- [ ] **Step 3: Implement `resources.rs` above the test module**

Insert at the TOP of `tools/rustbench/src/fleet/resources.rs`:
```rust
//! Cross-platform CPU + RSS sampling for the bench run (sysinfo). "cores" is
//! process CPU time over wall (a process pegging 4 cores reads ~4.0); "%" is
//! system-wide utilization. Started before the clock, stopped after, so startup
//! is excluded. Never panics the run: on an unavailable metric it records 0.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};

#[derive(Clone, Debug, Default)]
pub struct ResourceSummary {
    pub cpu_cores_avg: f64,
    pub cpu_cores_peak: f64,
    pub cpu_pct_avg: f64,
    pub cpu_pct_peak: f64,
    pub rss_avg_bytes: f64,
    pub rss_peak_bytes: u64,
    pub samples: u64,
}

pub struct ResourceSampler {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<ResourceSummary>,
}

pub fn start(interval_ms: u64) -> ResourceSampler {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let handle = std::thread::spawn(move || sample_loop(interval_ms, stop_thread));
    ResourceSampler { stop, handle }
}

impl ResourceSampler {
    pub fn stop(self) -> ResourceSummary {
        self.stop.store(true, Ordering::Relaxed);
        self.handle.join().unwrap_or_default()
    }
}

fn sample_loop(interval_ms: u64, stop: Arc<AtomicBool>) -> ResourceSummary {
    let pid = match sysinfo::get_current_pid() {
        Ok(p) => p,
        Err(_) => return ResourceSummary::default(),
    };
    let ncores = std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(1.0);
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );

    let mut summary = ResourceSummary::default();
    let mut cores_sum = 0.0f64;
    let mut pct_sum = 0.0f64;
    let mut rss_sum = 0.0f64;

    // sysinfo needs two refreshes to compute CPU%; prime once, then loop.
    sys.refresh_cpu_all();
    sys.refresh_process(pid);

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(interval_ms));
        sys.refresh_cpu_all();
        sys.refresh_process(pid);

        let (cores, rss) = match sys.process(pid) {
            Some(p) => (p.cpu_usage() as f64 / 100.0, p.memory()),
            None => (0.0, 0),
        };
        let pct = system_cpu_pct(&sys);

        summary.samples += 1;
        cores_sum += cores;
        pct_sum += pct;
        rss_sum += rss as f64;
        if cores > summary.cpu_cores_peak {
            summary.cpu_cores_peak = cores;
        }
        if pct > summary.cpu_pct_peak {
            summary.cpu_pct_peak = pct;
        }
        if rss > summary.rss_peak_bytes {
            summary.rss_peak_bytes = rss;
        }
        let _ = ncores; // reserved for cgroup-aware denominator (see spec)
    }

    if summary.samples > 0 {
        let n = summary.samples as f64;
        summary.cpu_cores_avg = cores_sum / n;
        summary.cpu_pct_avg = pct_sum / n;
        summary.rss_avg_bytes = rss_sum / n;
    }
    summary
}

/// System-wide CPU utilization 0..100 (average across cores).
fn system_cpu_pct(sys: &System) -> f64 {
    sys.global_cpu_usage() as f64
}
```

- [ ] **Step 4: Register the module**

In `tools/rustbench/src/fleet/mod.rs`, add:
```rust
pub mod resources;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p rustbench resources`
Expected: PASS (1 test). If it fails to compile on `refresh_cpu_all`/`global_cpu_usage`/`memory`, the resolved `sysinfo` version renamed them — check `cargo doc -p sysinfo` and adjust the call names (the loop structure stays). Do not change the test's expectations.

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench -- -D warnings
git add tools/rustbench/src/fleet/resources.rs tools/rustbench/src/fleet/mod.rs
git commit -m "feat(rustbench): cross-platform resource sampler"
```

---

### Task 4: Report formatting (`report.rs`)

**Files:**
- Create: `tools/rustbench/src/report.rs`
- Modify: `tools/rustbench/src/lib.rs` (add `pub mod report;`)
- Test: in-file `#[cfg(test)]` in `report.rs`

**Interfaces:**
- Consumes: `crate::cli::{BenchOpts, Runner}`, `crate::fleet::swarm::SwarmOutcome`, `crate::fleet::resources::ResourceSummary`.
- Produces:
  - `pub fn move_tps(moves: u64, elapsed_ms: u128) -> f64`
  - `pub fn format_resources(r: &ResourceSummary) -> String` — the loadbench `resources:` body (without the `[local/offchain] ` prefix).
  - `pub fn render(opts: &BenchOpts, simple: &SwarmOutcome, optimized: Option<&SwarmOutcome>, res: &ResourceSummary) -> String` — the full multi-line report. The headline lines describe `simple`; when `optimized` is `Some`, its TPS is appended in parentheses on the move-TPS line.

- [ ] **Step 1: Write the failing tests (golden strings)**

Create `tools/rustbench/src/report.rs` with the test module first:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{BenchOpts, Runner};
    use crate::fleet::resources::ResourceSummary;
    use crate::fleet::swarm::SwarmOutcome;

    fn opts(workers: usize, runner: Runner) -> BenchOpts {
        BenchOpts { workers, duration_secs: 15, matches: None, runner }
    }

    fn outcome(moves: u64, matches: u64, ms: u128) -> SwarmOutcome {
        SwarmOutcome { moves, bytes: 75982 * matches, tunnels_settled: matches, matches_claimed: matches, elapsed_ms: ms }
    }

    fn res() -> ResourceSummary {
        ResourceSummary {
            cpu_cores_avg: 11.2, cpu_cores_peak: 12.0,
            cpu_pct_avg: 93.0, cpu_pct_peak: 100.0,
            rss_avg_bytes: 58.0 * 1_048_576.0, rss_peak_bytes: 63 * 1_048_576,
            samples: 30,
        }
    }

    #[test]
    fn move_tps_matches_ratePerSec() {
        assert_eq!(move_tps(481234, 15000), 32082.266666666666);
    }

    #[test]
    fn format_resources_matches_loadbench_shape() {
        assert_eq!(
            format_resources(&res()),
            "cpu avg=11.2 cores (93%) peak=12.0 cores (100%), rss avg=58MB peak=63MB, samples=30"
        );
    }

    #[test]
    fn render_single_runner_has_no_parenthetical() {
        let s = render(&opts(12, Runner::Simple), &outcome(481234, 3366, 15000), None, &res());
        assert!(s.contains("[local/offchain] fleet: workers=12\n"));
        assert!(s.contains("[local/offchain] swarm: 481234 moves over 3366 matches in 15.0s\n"));
        assert!(s.contains("[local/offchain] tunnels settled: 3366 (224.4/s)\n"));
        assert!(s.contains("[local/offchain] aggregate move-TPS: 32082.3\n"));
        assert!(!s.contains("optimized:"));
        assert!(s.contains("[local/offchain] resources: cpu avg=11.2 cores"));
    }

    #[test]
    fn render_both_appends_optimized_tps() {
        let opt = outcome(616000, 4308, 15000); // ~41066.7 TPS
        let s = render(&opts(12, Runner::Both), &outcome(481234, 3366, 15000), Some(&opt), &res());
        assert!(s.contains("aggregate move-TPS: 32082.3   (optimized: 41066.7)\n"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rustbench report`
Expected: FAIL (compile error — functions not defined).

- [ ] **Step 3: Implement `report.rs` above the test module**

Insert at the TOP of `tools/rustbench/src/report.rs`:
```rust
//! Console report, format-parity with the loadbench swarm output. Pure string
//! building — the binary prints the result. Headline lines describe the simple
//! runner; the optimized runner's TPS is appended on the move-TPS line.

use crate::cli::BenchOpts;
use crate::fleet::resources::ResourceSummary;
use crate::fleet::swarm::SwarmOutcome;

const PREFIX: &str = "[local/offchain]";

pub fn move_tps(moves: u64, elapsed_ms: u128) -> f64 {
    if elapsed_ms == 0 {
        return 0.0;
    }
    (moves as f64) * 1000.0 / (elapsed_ms as f64)
}

fn rate_per_sec(count: u64, elapsed_ms: u128) -> f64 {
    if elapsed_ms == 0 {
        return 0.0;
    }
    (count as f64) * 1000.0 / (elapsed_ms as f64)
}

fn mb(bytes: f64) -> u64 {
    (bytes / 1_048_576.0).round() as u64
}

pub fn format_resources(r: &ResourceSummary) -> String {
    format!(
        "cpu avg={:.1} cores ({:.0}%) peak={:.1} cores ({:.0}%), rss avg={}MB peak={}MB, samples={}",
        r.cpu_cores_avg,
        r.cpu_pct_avg,
        r.cpu_cores_peak,
        r.cpu_pct_peak,
        mb(r.rss_avg_bytes),
        mb(r.rss_peak_bytes as f64),
        r.samples,
    )
}

pub fn render(
    opts: &BenchOpts,
    simple: &SwarmOutcome,
    optimized: Option<&SwarmOutcome>,
    res: &ResourceSummary,
) -> String {
    let secs = simple.elapsed_ms as f64 / 1000.0;
    let tps = move_tps(simple.moves, simple.elapsed_ms);
    let tps_line = match optimized {
        Some(o) => format!(
            "{PREFIX} aggregate move-TPS: {:.1}   (optimized: {:.1})",
            tps,
            move_tps(o.moves, o.elapsed_ms)
        ),
        None => format!("{PREFIX} aggregate move-TPS: {:.1}", tps),
    };
    format!(
        "{PREFIX} fleet: workers={}\n\
         {PREFIX} swarm: {} moves over {} matches in {:.1}s\n\
         {PREFIX} tunnels settled: {} ({:.1}/s)\n\
         {tps_line}\n\
         {PREFIX} resources: {}\n",
        opts.workers,
        simple.moves,
        simple.matches_claimed,
        secs,
        simple.tunnels_settled,
        rate_per_sec(simple.tunnels_settled, simple.elapsed_ms),
        format_resources(res),
    )
}
```

- [ ] **Step 4: Register the module**

In `tools/rustbench/src/lib.rs`, add after `pub mod report;`'s neighbors (e.g. after `pub mod fleet;`):
```rust
pub mod report;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p rustbench report`
Expected: PASS (4 tests). If `move_tps_matches_ratePerSec` fails on the float literal, print the actual value and use it verbatim — it is `moves*1000/ms` in f64 and must match the formula, not be hand-rounded.

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench -- -D warnings
git add tools/rustbench/src/report.rs tools/rustbench/src/lib.rs
git commit -m "feat(rustbench): format-parity bench report"
```

---

### Task 5: Binary wiring + end-to-end smoke (`main.rs`)

**Files:**
- Create: `tools/rustbench/src/main.rs`
- Test: `tools/rustbench/tests/bench_smoke.rs` (integration — runs the built binary)

**Interfaces:**
- Consumes: `rustbench::cli`, `rustbench::fleet::{swarm, resources}`, `rustbench::report`.
- Produces: the `rustbench` binary. With `--runner simple` it runs one fleet window with resource sampling and prints the report; on a CLI error it prints the message to stderr and exits non-zero.

- [ ] **Step 1: Implement `main.rs`**

Create `tools/rustbench/src/main.rs`:
```rust
//! `rustbench` swarm bench binary. Parses flags, runs the rayon fleet under a
//! resource sampler, and prints the loadbench-shaped report. Optimized runner is
//! wired in Task 6; until then `--runner optimized|both` runs the simple fleet
//! and reports it as the simple figure.

use rustbench::cli::{self, Runner};
use rustbench::fleet::{resources, swarm};
use rustbench::report;

fn main() {
    let opts = match cli::parse(std::env::args().skip(1)) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    // Simple runner window (the honest baseline). Sampler brackets the run.
    let sampler = resources::start(250);
    let simple = swarm::run_simple(opts.workers, opts.duration_secs, opts.matches);
    let res = sampler.stop();

    // Optimized runner is added in Task 6; for now report only the simple figure.
    let _ = Runner::Both;
    print!("{}", report::render(&opts, &simple, None, &res));
}
```

- [ ] **Step 2: Write the failing integration smoke test**

Create `tools/rustbench/tests/bench_smoke.rs`:
```rust
//! End-to-end smoke: the built binary runs a tiny matches-bounded fleet and
//! prints the report lines. Uses CARGO_BIN_EXE_rustbench (Cargo sets this for
//! integration tests of a crate with a binary).

use std::process::Command;

#[test]
fn binary_runs_and_prints_report_lines() {
    let exe = env!("CARGO_BIN_EXE_rustbench");
    let out = Command::new(exe)
        .args(["--offchain", "--channel", "local", "--game", "blackjack", "--workers", "1", "--matches", "3", "--runner", "simple"])
        .output()
        .expect("run rustbench");
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("[local/offchain] fleet: workers=1\n"), "got:\n{stdout}");
    // 3 matches * 143 moves = 429 moves, 3 tunnels.
    assert!(stdout.contains("swarm: 429 moves over 3 matches"), "got:\n{stdout}");
    assert!(stdout.contains("tunnels settled: 3 "), "got:\n{stdout}");
    assert!(stdout.contains("aggregate move-TPS:"), "got:\n{stdout}");
    assert!(stdout.contains("resources: cpu avg="), "got:\n{stdout}");
}

#[test]
fn rejects_unsupported_flag() {
    let exe = env!("CARGO_BIN_EXE_rustbench");
    let out = Command::new(exe).args(["--onchain"]).output().expect("run");
    assert!(!out.status.success());
}
```

- [ ] **Step 3: Run to verify (the smoke should pass once the binary builds)**

Run: `cargo test -p rustbench --test bench_smoke`
Expected: PASS (2 tests). If `CARGO_BIN_EXE_rustbench` is undefined, confirm `src/main.rs` exists so Cargo registers the binary target.

- [ ] **Step 4: Manual check (optional, not committed)**

Run: `cargo run -p rustbench --release -- --offchain --channel local --game blackjack --duration 2 --runner simple`
Expected: five `[local/offchain]` lines; a non-trivial move-TPS.

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench -- -D warnings
git add tools/rustbench/src/main.rs tools/rustbench/tests/bench_smoke.rs
git commit -m "feat(rustbench): wire swarm bench binary"
```

---

### Task 6: Optimized runner (cached keys) + report both TPS

**Files:**
- Modify: `tools/rustbench/src/engine/crypto.rs` (derive `Clone` on `KeyPair`)
- Modify: `tools/rustbench/src/engine/tunnel.rs` (add `Endpoint::controlled_with_pk`)
- Modify: `tools/rustbench/src/driver.rs` (add `SeatKit` + `play_prepared`)
- Modify: `tools/rustbench/src/fleet/swarm.rs` (add `run_optimized`)
- Modify: `tools/rustbench/src/main.rs` (run both windows when `--runner both`/`optimized`)
- Test: in-file `#[cfg(test)]` in `driver.rs` (runner parity) and `swarm.rs` (optimized determinism)

**Interfaces:**
- Consumes: `crate::engine::crypto::{KeyPair, keypair_from_secret}`, `crate::engine::tunnel::{DistTunnel, Endpoint}`, the Plan 2 `play_fixed_match`.
- Produces:
  - `crypto::KeyPair: Clone`
  - `Endpoint::controlled_with_pk(kp: KeyPair, public_key: [u8; 32]) -> Endpoint`
  - `driver::SeatKit { /* cached kp_a, pk_a, kp_b, pk_b */ }` with `pub fn new(secret_a: &[u8;32], secret_b: &[u8;32]) -> SeatKit`
  - `driver::play_prepared(kit: &SeatKit, tunnel_id: &str, balance_a: u64, balance_b: u64, created_at: u64, max_moves: u64) -> MatchResult`
  - `fleet::swarm::run_optimized(workers, duration_secs, matches) -> SwarmOutcome`

**Why this is the safe optimization:** `play_fixed_match` re-derives both public keys (two scalar multiplications) and re-expands both signing keys every match. `SeatKit` caches the expanded `KeyPair`s and their public keys once per worker; `play_prepared` clones the cached `KeyPair` (a cheap copy of the already-expanded key, no re-expansion) and reuses the cached public key for the observer endpoint. This removes the per-match key derivation without touching a single byte of the signed/frame path. Deeper frame-buffer pooling is intentionally **out of scope** here — it would require modifying the byte-exact codec and risk the parity contract; the simple-vs-optimized delta from key caching is the reported payoff.

- [ ] **Step 1: Write the failing tests (parity + determinism)**

Add to the existing `#[cfg(test)] mod tests` in `tools/rustbench/src/driver.rs`:
```rust
    #[test]
    fn play_prepared_is_byte_identical_to_play_fixed_match() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let baseline = play_fixed_match("0xab", &sa, &sb, 200, 200, 1234567890, 500);
        let kit = SeatKit::new(&sa, &sb);
        let prepared = play_prepared(&kit, "0xab", 200, 200, 1234567890, 500);
        assert_eq!(prepared.moves, baseline.moves);
        assert_eq!(prepared.bytes, baseline.bytes);
        assert_eq!(prepared.final_balance_a, baseline.final_balance_a);
        assert_eq!(prepared.final_balance_b, baseline.final_balance_b);
        assert_eq!(prepared.settlement.final_nonce, baseline.settlement.final_nonce);
        assert_eq!(prepared.sig_a, baseline.sig_a);
        assert_eq!(prepared.sig_b, baseline.sig_b);
    }
```
Add to `#[cfg(test)] mod tests` in `tools/rustbench/src/fleet/swarm.rs`:
```rust
    #[test]
    fn optimized_runner_matches_simple_totals() {
        let simple = run_simple(2, 3600, Some(8));
        let optimized = run_optimized(2, 3600, Some(8));
        assert_eq!(optimized.moves, simple.moves);
        assert_eq!(optimized.bytes, simple.bytes);
        assert_eq!(optimized.tunnels_settled, simple.tunnels_settled);
    }
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench -- play_prepared optimized_runner`
Expected: FAIL (`SeatKit`, `play_prepared`, `run_optimized` not defined).

- [ ] **Step 3: Derive `Clone` on `KeyPair`**

In `tools/rustbench/src/engine/crypto.rs`, change the struct definition:
```rust
#[derive(Clone)]
pub struct KeyPair {
    signing: SigningKey,
}
```
(`ed25519_dalek::SigningKey` implements `Clone`, so this compiles unchanged otherwise.)

- [ ] **Step 4: Add `Endpoint::controlled_with_pk`**

In `tools/rustbench/src/engine/tunnel.rs`, inside `impl Endpoint`, add after `observer`:
```rust
    /// Like `controlled`, but reuses an already-expanded keypair and its known
    /// public key (avoids re-deriving the public key per match in the bench).
    pub fn controlled_with_pk(kp: KeyPair, public_key: [u8; 32]) -> Endpoint {
        Endpoint {
            public_key,
            signing: Some(kp),
        }
    }
```

- [ ] **Step 5: Add `SeatKit` + `play_prepared` to `driver.rs`**

In `tools/rustbench/src/driver.rs`, add the import for `KeyPair` to the existing crypto `use` line and append below `play_fixed_match`:
```rust
use crate::engine::crypto::KeyPair;

/// Per-worker cached seat material: expanded signing keys + their public keys,
/// derived once so the per-match path skips key expansion and public-key derivation.
pub struct SeatKit {
    kp_a: KeyPair,
    pk_a: [u8; 32],
    kp_b: KeyPair,
    pk_b: [u8; 32],
}

impl SeatKit {
    pub fn new(secret_a: &[u8; 32], secret_b: &[u8; 32]) -> SeatKit {
        let kp_a = keypair_from_secret(secret_a);
        let kp_b = keypair_from_secret(secret_b);
        let pk_a = kp_a.public_key();
        let pk_b = kp_b.public_key();
        SeatKit { kp_a, pk_a, kp_b, pk_b }
    }
}

/// Byte-identical to `play_fixed_match`, but seats are built from cached key
/// material (no per-call key expansion / public-key derivation).
pub fn play_prepared(
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
) -> MatchResult {
    let mut dt_a = DistTunnel::new(
        tunnel_id,
        Party::A,
        Endpoint::controlled_with_pk(kit.kp_a.clone(), kit.pk_a),
        Endpoint::observer(kit.pk_b),
        balance_a,
        balance_b,
    );
    let mut dt_b = DistTunnel::new(
        tunnel_id,
        Party::B,
        Endpoint::controlled_with_pk(kit.kp_b.clone(), kit.pk_b),
        Endpoint::observer(kit.pk_a),
        balance_a,
        balance_b,
    );
    play_loop(&mut dt_a, &mut dt_b, tunnel_id, created_at, max_moves)
}
```
This requires the post-construction body of `play_fixed_match` to be shared. Extract it: in `play_fixed_match`, replace everything AFTER the two `DistTunnel::new(...)` bindings (the move-pumping loop + settlement) with a call `play_loop(&mut dt_a, &mut dt_b, tunnel_id, created_at, max_moves)`, and define `play_loop` as a private `fn` holding that exact moved code (the `plan`/`propose`/`deliver` loop and the `build_settlement_half_with_root` + `combine_settlement_with_root` + `MatchResult` construction, unchanged). Do not alter any logic — this is a pure extract-function refactor so both entry points share one body. Re-run the Plan 2 gate after (Step 7) to prove no byte changed.

- [ ] **Step 6: Add `run_optimized` to `swarm.rs`**

In `tools/rustbench/src/fleet/swarm.rs`, add the import and function:
```rust
use crate::driver::{play_prepared, SeatKit};
```
```rust
/// Optimized fleet: each worker caches one `SeatKit` and runs `play_prepared`.
pub fn run_optimized(workers: usize, duration_secs: u64, matches: Option<u64>) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |tunnel_id| {
        // SeatKit is cheap to build; building per match still skips public-key
        // derivation only if cached. Build it once per closure call is fine here
        // because `run_with` calls this per match — instead cache via thread_local.
        thread_local! {
            static KIT: SeatKit = SeatKit::new(&SEAT_A, &SEAT_B);
        }
        KIT.with(|kit| {
            let r = play_prepared(kit, &tunnel_id, 200, 200, CREATED_AT, MAX_MOVES);
            (r.moves, r.bytes as u64)
        })
    })
}
```
Note: the `thread_local!` makes the `SeatKit` per worker-thread, derived once and reused across every match that thread runs — that is where the key-derivation saving lands. `SEAT_A`/`SEAT_B`/`CREATED_AT`/`MAX_MOVES` are already defined in this module.

- [ ] **Step 7: Run the parity + determinism + Plan 2 gate**

Run: `cargo test -p rustbench`
Expected: PASS — including `play_prepared_is_byte_identical_to_play_fixed_match`, `optimized_runner_matches_simple_totals`, and the unchanged `fixed_match_matches_ts_golden` Plan 2 gate. If the gate broke, the extract-function refactor changed behavior — revert and redo it as a pure move.

- [ ] **Step 8: Wire both runners into `main.rs`**

Replace the body of `main` after `opts` parsing in `tools/rustbench/src/main.rs`:
```rust
    let (simple, optimized, res) = match opts.runner {
        Runner::Simple => {
            let sampler = resources::start(250);
            let simple = swarm::run_simple(opts.workers, opts.duration_secs, opts.matches);
            (simple, None, sampler.stop())
        }
        Runner::Optimized => {
            let sampler = resources::start(250);
            let optimized = swarm::run_optimized(opts.workers, opts.duration_secs, opts.matches);
            // Report the optimized window as the headline; no parenthetical.
            (optimized, None, sampler.stop())
        }
        Runner::Both => {
            // Simple window first (the resources line describes it), then optimized.
            let sampler = resources::start(250);
            let simple = swarm::run_simple(opts.workers, opts.duration_secs, opts.matches);
            let res = sampler.stop();
            let optimized = swarm::run_optimized(opts.workers, opts.duration_secs, opts.matches);
            (simple, Some(optimized), res)
        }
    };
    print!("{}", report::render(&opts, &simple, optimized.as_ref(), &res));
```
Remove the now-unused `let _ = Runner::Both;` line and the old single-window block from Task 5.

- [ ] **Step 9: Full suite + manual both-runner check**

Run: `cargo test -p rustbench && cargo clippy -p rustbench -- -D warnings`
Expected: all green, no warnings.
Optional manual: `cargo run -p rustbench --release -- --offchain --channel local --game blackjack --duration 3`
Expected: the move-TPS line shows `... (optimized: ...)`; optimized ≥ simple is typical but not asserted.

- [ ] **Step 10: fmt + commit**

```bash
cargo fmt -p rustbench
git add tools/rustbench/src/engine/crypto.rs tools/rustbench/src/engine/tunnel.rs tools/rustbench/src/driver.rs tools/rustbench/src/fleet/swarm.rs tools/rustbench/src/main.rs
git commit -m "feat(rustbench): optimized cached-key runner, report both tps"
```

---

## Verification of the whole plan

- The Plan 2 parity gate (`tests/blackjack_match.rs::fixed_match_matches_ts_golden`) must still pass unchanged after Task 6's extract-function refactor — it is the guard that the binary's match path stays byte-exact with the TS driver.
- Deterministic fleet totals (`--workers 1 --matches N` ⇒ `143*N` moves, `N` tunnels, `75982*N` bytes) are the regression gate for the swarm; they hold for both runners.
- The headline command `rustbench --offchain --channel local --game blackjack` parses and prints the five `[local/offchain]` lines, ready to compare against `bun run bench --offchain --channel local --game blackjack` on the same machine.

## Follow-on (not in this plan)

- Plan 4 — latency mode (p50/p99 per match; needs per-move timestamps in `MatchResult`).
- Plan 5 — relay channel (tokio IO path).
- Plan 6 — onchain anchor (PTB open + cooperative settle).
- Deferred optimizations: frame-buffer pooling (requires codec changes; guard with the parity gate), core pinning (`--pin`), the multi-game markdown table (`--game all`).
