# rustbench Richer Metrics + Varied Gameplay + Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-game match/tunnel counts, a moves-per-match distribution, dual (wall vs play-only) throughput with setup excluded, CPU/RSS percentiles with a cgroup-aware denominator, fresh-keys-by-default harness parity, varied-by-default gameplay, and a container image to `rustbench`.

**Architecture:** Thread an optional per-match card seed through the deterministic blackjack stream so matches vary while a `None` seed reproduces the byte-exact golden match. The fleet collects a per-worker `Vec<MatchSample>` (no atomic contention), merges it, and summarizes exact percentiles. The driver times only the play loop (`play_ns`), excluding per-match key/tunnel setup. A cgroup module supplies the CPU-utilization denominator so container runs read correctly.

**Tech Stack:** Rust 2021; existing deps + `getrandom` (already added). Builds on `tools/rustbench/` (engine, game, driver, fleet, report, cli).

**Design spec:** `docs/superpowers/specs/2026-06-26-rustbench-metrics-and-container-design.md`.

## Global Constraints

- All work under `tools/rustbench/` plus a `Dockerfile`. Do **not** touch `backend/`, `sui-tunnel-ts/`, `frontend/`, `tools/loadbench/`.
- The **signed/verified protocol path is unchanged**: every move co-signed + both signatures verified; settlement co-signed + verified.
- `--deterministic` (card seed `None`) reproduces the Plan 2 golden match byte-for-byte. The gate `tools/rustbench/tests/blackjack_match.rs::fixed_match_matches_ts_golden` must pass **with its call site unchanged** (the public `play_fixed_match`/`play_prepared` signatures do not change; deterministic is their default).
- Card seed must **not** enter `encode_state` (it would change the state hash). It is carried on `BjState` but never serialized.
- Varied gameplay (default) makes per-match move counts vary; the `143*N` fleet-total guarantees hold **only** under deterministic mode, which is what the determinism tests use.
- CPU-bound fleet stays on rayon threads; no async/tokio.
- Exact percentiles via sort (nearest-rank), not streaming estimators.
- Each task ends `cargo clippy -p rustbench --all-targets -- -D warnings` clean and `cargo fmt -p rustbench` applied. Conventional Commits, no AI attribution.

Baseline commit: `df70a2f` (adds the current `--fresh-keys` flag, default off; Task 6 flips the default).

---

### Task 1: Per-match card seed (deterministic-preserving)

**Files:**
- Modify: `tools/rustbench/src/game/blackjack.rs` (BjState field, `initial_state`, `draw_rank`, `draw_to`, `deal_round`, `resolve_dealer`, `apply_move`)
- Modify: `tools/rustbench/src/engine/tunnel.rs` (`DistTunnel::new` gains `card_seed`)
- Modify: `tools/rustbench/src/driver.rs` (`play_fixed_match_seeded`/`play_prepared_seeded`; public fns delegate with `None`)
- Test: in-file `#[cfg(test)]` in `blackjack.rs`

**Interfaces:**
- Produces:
  - `blackjack::initial_state(balance_a: u64, balance_b: u64, card_seed: Option<u64>) -> BjState`
  - `BjState { …, pub card_seed: Option<u64> }` (NOT in `encode_state`)
  - `tunnel::DistTunnel::new(tunnel_id, self_party, self_ep, opp_ep, balance_a, balance_b, card_seed: Option<u64>)`
  - `driver::play_fixed_match_seeded(card_seed: Option<u64>, tunnel_id: &str, secret_a: &[u8;32], secret_b: &[u8;32], balance_a: u64, balance_b: u64, created_at: u64, max_moves: u64) -> MatchResult`
  - `driver::play_prepared_seeded(card_seed: Option<u64>, kit: &SeatKit, tunnel_id: &str, balance_a: u64, balance_b: u64, created_at: u64, max_moves: u64) -> MatchResult`
  - Public `play_fixed_match`/`play_prepared` keep their existing signatures and delegate with `None`.

- [ ] **Step 1: Write the failing tests in `blackjack.rs`**

Add to the existing `#[cfg(test)] mod tests` in `tools/rustbench/src/game/blackjack.rs`:
```rust
    #[test]
    fn seed_none_reproduces_legacy_card_stream() {
        // The deterministic (None) stream is unchanged: first dealt rank is stable.
        assert_eq!(draw_rank(None, 1, 0), draw_rank(None, 1, 0));
        // A seed changes the stream for at least one early draw.
        let any_diff = (0..8u64).any(|i| draw_rank(Some(7), 1, i) != draw_rank(None, 1, i));
        assert!(any_diff, "a seed must perturb the card stream");
    }

    #[test]
    fn seed_is_not_encoded_into_state() {
        let a = initial_state(200, 200, None);
        let mut b = initial_state(200, 200, Some(42));
        b.card_seed = Some(99); // any seed
        assert_eq!(encode_state(&a), encode_state(&b), "card_seed must not affect encode_state");
    }
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench -- seed_none_reproduces seed_is_not_encoded`
Expected: FAIL (compile error — `draw_rank` arity, `initial_state` arity, `card_seed` field missing).

- [ ] **Step 3: Add the `card_seed` field to `BjState`**

In `tools/rustbench/src/game/blackjack.rs`, add the field to the struct (after `bet`):
```rust
    pub bet: u64,
    /// Per-match card-stream seed. `None` = the legacy deterministic stream
    /// (golden). Never serialized — `encode_state` must ignore it.
    pub card_seed: Option<u64>,
```

- [ ] **Step 4: Thread the seed through derivation**

Replace `draw_rank` and `draw_to`:
```rust
fn draw_rank(card_seed: Option<u64>, round: u64, draw_index: u64) -> u8 {
    let mut buf = Vec::with_capacity(DOMAIN.len() + 16);
    buf.extend_from_slice(DOMAIN);
    if let Some(seed) = card_seed {
        buf.extend_from_slice(&u64_to_be_bytes(seed));
    }
    buf.extend_from_slice(&u64_to_be_bytes(round));
    let mut digest = blake2b256(&buf);
    let idx = draw_index as usize;
    let block = idx / 32;
    for b in 0..block {
        let mut next = Vec::with_capacity(32 + 8);
        next.extend_from_slice(&digest);
        next.extend_from_slice(&u64_to_be_bytes(b as u64));
        digest = blake2b256(&next);
    }
    (digest[idx % 32] % 13) + 1
}

fn draw_to(hand: &mut Vec<u8>, card_seed: Option<u64>, round: u64, draw_index: u64) -> u64 {
    hand.push(rank_value(draw_rank(card_seed, round, draw_index)));
    draw_index + 1
}
```

- [ ] **Step 5: Pass `s.card_seed` at every draw site**

In `deal_round`, change both loops to pass the seed:
```rust
    for _ in 0..2 {
        draw_index = draw_to(&mut player_hand, s.card_seed, round, draw_index);
    }
    for _ in 0..2 {
        draw_index = draw_to(&mut dealer_hand, s.card_seed, round, draw_index);
    }
```
In `resolve_dealer`, change the draw call:
```rust
        draw_index = draw_to(&mut hand, s.card_seed, s.round, draw_index);
```
In `apply_move`'s `Phase::Player` hit branch (around the `next.draw_index = draw_to(...)` line):
```rust
                    next.draw_index = draw_to(&mut next.player_hand, s.card_seed, s.round, s.draw_index);
```
(`deal_round` already returns `BjState { …, ..s.clone() }`, and `apply_move` clones `s`, so `card_seed` propagates automatically. Do not add `card_seed` to `encode_state`.)

- [ ] **Step 6: Update `initial_state` to set the seed**

```rust
pub fn initial_state(balance_a: u64, balance_b: u64, card_seed: Option<u64>) -> BjState {
    BjState {
        phase: Phase::RoundOver,
        round: 0,
        draw_index: 0,
        player_hand: Vec::new(),
        dealer_hand: Vec::new(),
        balance_a,
        balance_b,
        total: balance_a + balance_b,
        bet: 0,
        card_seed,
    }
}
```
Update any other `initial_state(...)` call inside `blackjack.rs` tests to pass `None`.

- [ ] **Step 7: Thread the seed through `DistTunnel::new`**

In `tools/rustbench/src/engine/tunnel.rs`, change `new` to accept and forward `card_seed`:
```rust
    pub fn new(
        tunnel_id: &str,
        self_party: Party,
        self_ep: Endpoint,
        opp_ep: Endpoint,
        balance_a: u64,
        balance_b: u64,
        card_seed: Option<u64>,
    ) -> DistTunnel {
        let state = crate::game::blackjack::initial_state(balance_a, balance_b, card_seed);
        DistTunnel {
            tunnel_id: tunnel_id.to_string(),
            self_party,
            self_ep,
            opp_ep,
            total: balance_a + balance_b,
            state,
            nonce: 0,
            pending: None,
        }
    }
```
Update the two `DistTunnel::new(...)` calls in `tunnel.rs`'s own `#[cfg(test)] seats()` helper to pass `None` as the final argument.

- [ ] **Step 8: Add seeded driver entry points; public fns delegate with `None`**

In `tools/rustbench/src/driver.rs`, rename the body of `play_fixed_match` into `play_fixed_match_seeded` (adding `card_seed` as the first param and passing it to both `DistTunnel::new` calls), and make `play_fixed_match` delegate:
```rust
pub fn play_fixed_match(
    tunnel_id: &str,
    secret_a: &[u8; 32],
    secret_b: &[u8; 32],
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
) -> MatchResult {
    play_fixed_match_seeded(
        None, tunnel_id, secret_a, secret_b, balance_a, balance_b, created_at, max_moves,
    )
}

pub fn play_fixed_match_seeded(
    card_seed: Option<u64>,
    tunnel_id: &str,
    secret_a: &[u8; 32],
    secret_b: &[u8; 32],
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
) -> MatchResult {
    let pka = keypair_from_secret(secret_a).public_key();
    let pkb = keypair_from_secret(secret_b).public_key();
    let mut dt_a = DistTunnel::new(
        tunnel_id, Party::A,
        Endpoint::controlled(secret_a), Endpoint::observer(pkb),
        balance_a, balance_b, card_seed,
    );
    let mut dt_b = DistTunnel::new(
        tunnel_id, Party::B,
        Endpoint::controlled(secret_b), Endpoint::observer(pka),
        balance_a, balance_b, card_seed,
    );
    play_loop(&mut dt_a, &mut dt_b, tunnel_id, created_at, max_moves)
}
```
Do the same split for `play_prepared` → `play_prepared_seeded(card_seed, kit, tunnel_id, balance_a, balance_b, created_at, max_moves)`, passing `card_seed` to both `DistTunnel::new` calls (using `Endpoint::controlled_with_pk(kit.kp_a.clone(), kit.pk_a)` etc. as today), and `play_prepared(...)` delegates with `None`.

- [ ] **Step 9: Run the new tests + the golden gate**

Run: `cargo test -p rustbench`
Expected: PASS — including `seed_none_reproduces_legacy_card_stream`, `seed_is_not_encoded_into_state`, the unchanged `fixed_match_matches_ts_golden`, and `play_prepared_is_byte_identical_to_play_fixed_match`. If the golden broke, a draw site still hashes the seed on the `None` path — re-check Step 4 (the `if let Some` guard).

- [ ] **Step 10: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench --all-targets -- -D warnings
git add tools/rustbench/src/game/blackjack.rs tools/rustbench/src/engine/tunnel.rs tools/rustbench/src/driver.rs
git commit -m "feat(rustbench): per-match card seed for varied gameplay"
```

---

### Task 2: Play-loop timing (`play_ns`)

**Files:**
- Modify: `tools/rustbench/src/driver.rs` (`MatchResult` + time only `play_loop`)
- Test: in-file `#[cfg(test)]` in `driver.rs`

**Interfaces:**
- Consumes: `play_fixed_match_seeded`, `play_prepared_seeded` (Task 1).
- Produces: `MatchResult { …, pub play_ns: u128 }` — nanoseconds spent in `play_loop` only (setup excluded).

- [ ] **Step 1: Write the failing test**

Add to `#[cfg(test)] mod tests` in `tools/rustbench/src/driver.rs`:
```rust
    #[test]
    fn match_result_reports_play_ns() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let r = play_fixed_match("0xab", &sa, &sb, 200, 200, 1234567890, 500);
        assert!(r.play_ns > 0, "play loop must take measurable time");
    }
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench match_result_reports_play_ns`
Expected: FAIL (no field `play_ns`).

- [ ] **Step 3: Add the field and time the play loop**

In `tools/rustbench/src/driver.rs`, add `pub play_ns: u128,` to `MatchResult`. `play_loop` already builds the `MatchResult`; give it the timing by wrapping its move/settlement work. The simplest correct placement: have `play_loop` start an `Instant` at its top and set `play_ns` when constructing the result. Add `use std::time::Instant;` and, in `play_loop`, capture `let started = Instant::now();` as the first line and set `play_ns: started.elapsed().as_nanos(),` in the returned `MatchResult { … }`. Because `play_fixed_match_seeded`/`play_prepared_seeded` do all key/tunnel setup *before* calling `play_loop`, setup is excluded.

- [ ] **Step 4: Run to verify pass + parity intact**

Run: `cargo test -p rustbench`
Expected: PASS — `match_result_reports_play_ns`, the golden gate, and `play_prepared_is_byte_identical_to_play_fixed_match` (it compares moves/bytes/balances/sigs, not `play_ns`).

- [ ] **Step 5: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench --all-targets -- -D warnings
git add tools/rustbench/src/driver.rs
git commit -m "feat(rustbench): time the play loop, exclude setup"
```

---

### Task 3: Distribution helper (`fleet/stats.rs`)

**Files:**
- Create: `tools/rustbench/src/fleet/stats.rs`
- Modify: `tools/rustbench/src/fleet/mod.rs` (`pub mod stats;`)
- Test: in-file `#[cfg(test)]` in `stats.rs`

**Interfaces:**
- Produces:
  - `#[derive(Clone, Debug, Default)] pub struct Distribution { pub count: u64, pub avg: f64, pub min: f64, pub p50: f64, pub p90: f64, pub p99: f64, pub peak: f64 }`
  - `pub fn summarize(values: &[f64]) -> Distribution` — empty slice ⇒ `Distribution::default()`; percentiles are nearest-rank over a sorted copy.

- [ ] **Step 1: Write the failing tests**

Create `tools/rustbench/src/fleet/stats.rs` with the test module first:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_is_default() {
        let d = summarize(&[]);
        assert_eq!(d.count, 0);
        assert_eq!(d.avg, 0.0);
    }

    #[test]
    fn percentiles_nearest_rank() {
        let xs: Vec<f64> = (1..=100).map(|i| i as f64).collect();
        let d = summarize(&xs);
        assert_eq!(d.count, 100);
        assert_eq!(d.min, 1.0);
        assert_eq!(d.peak, 100.0);
        assert_eq!(d.avg, 50.5);
        assert_eq!(d.p50, 50.0); // nearest-rank: ceil(0.50*100)=50 -> xs[49]=50
        assert_eq!(d.p90, 90.0);
        assert_eq!(d.p99, 99.0);
    }

    #[test]
    fn single_value() {
        let d = summarize(&[7.0]);
        assert_eq!(d.count, 1);
        assert_eq!(d.avg, 7.0);
        assert_eq!(d.p50, 7.0);
        assert_eq!(d.p99, 7.0);
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench stats`
Expected: FAIL (compile error — `summarize`, `Distribution` undefined).

- [ ] **Step 3: Implement above the test module**

Insert at the TOP of `tools/rustbench/src/fleet/stats.rs`:
```rust
//! Exact summary statistics over a sample slice. Used for moves-per-match,
//! play-loop duration, CPU utilization, and RSS. Percentiles are nearest-rank
//! over a sorted copy — the sample volume is small (a few hundred thousand at
//! most), so an exact sort beats a streaming estimator.

#[derive(Clone, Debug, Default)]
pub struct Distribution {
    pub count: u64,
    pub avg: f64,
    pub min: f64,
    pub p50: f64,
    pub p90: f64,
    pub p99: f64,
    pub peak: f64,
}

/// Nearest-rank percentile (`p` in 0..=100) over an already-sorted slice.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    let idx = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[idx]
}

pub fn summarize(values: &[f64]) -> Distribution {
    if values.is_empty() {
        return Distribution::default();
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let count = sorted.len();
    let sum: f64 = sorted.iter().sum();
    Distribution {
        count: count as u64,
        avg: sum / count as f64,
        min: sorted[0],
        p50: percentile(&sorted, 50.0),
        p90: percentile(&sorted, 90.0),
        p99: percentile(&sorted, 99.0),
        peak: sorted[count - 1],
    }
}
```

- [ ] **Step 4: Register the module**

In `tools/rustbench/src/fleet/mod.rs`, add:
```rust
pub mod stats;
```

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p rustbench stats`
Expected: PASS (3 tests).

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench --all-targets -- -D warnings
git add tools/rustbench/src/fleet/stats.rs tools/rustbench/src/fleet/mod.rs
git commit -m "feat(rustbench): exact distribution summary helper"
```

---

### Task 4: Fleet sample collection + card mode + counters

**Files:**
- Modify: `tools/rustbench/src/fleet/swarm.rs` (MatchSample, `run_with` rewrite, `SwarmOutcome` additions, runners take `CardMode`)
- Modify: `tools/rustbench/src/main.rs` (keep the binary compiling against the new 4-arg runner signatures — stopgap `CardMode::Varied`; Task 6 wires the flag)
- Modify: `tools/rustbench/src/report.rs` (add the new `SwarmOutcome` fields to the test `outcome(...)` helper so the crate compiles; Task 6 enriches them)
- Test: in-file `#[cfg(test)]` in `swarm.rs`

**Interfaces:**
- Consumes: `play_fixed_match_seeded`/`play_prepared_seeded` (Task 1), `MatchResult.play_ns` (Task 2), `stats::{Distribution, summarize}` (Task 3).
- Produces:
  - `#[derive(Clone, Copy, PartialEq, Eq, Debug)] pub enum CardMode { Varied, Deterministic }`
  - `SwarmOutcome` keeps existing fields (`moves`, `bytes`, `tunnels_settled`, `matches_claimed`, `elapsed_ms`) and **adds**: `pub tunnels_opened: u64`, `pub play_ns_total: u128`, `pub total_ns_total: u128`, `pub moves_dist: Distribution`, `pub play_ns_dist: Distribution`.
  - Runner signatures gain a trailing `mode: CardMode`:
    `run_simple(workers, duration_secs, matches, mode)`, `run_fresh_keys(…, mode)`, `run_optimized(…, mode)`.

- [ ] **Step 1: Update the existing swarm tests to pass `CardMode` and add coverage**

In `tools/rustbench/src/fleet/swarm.rs` `#[cfg(test)] mod tests`, update the three existing deterministic-total tests to pass `CardMode::Deterministic` as the final argument (e.g. `run_simple(1, 3600, Some(5), CardMode::Deterministic)`), update `optimized_runner_matches_simple_totals` and `fresh_keys_runner_conserves_totals` likewise with `CardMode::Deterministic`, and add:
```rust
    #[test]
    fn varied_mode_produces_a_nondegenerate_move_distribution() {
        let out = run_simple(2, 3600, Some(200), CardMode::Varied);
        assert_eq!(out.tunnels_settled, 200);
        assert_eq!(out.matches_claimed, 200);
        // Varied cards => not every match is 143 moves.
        assert!(out.moves_dist.peak > out.moves_dist.min, "moves should vary: {:?}", out.moves_dist);
        assert!(out.play_ns_total > 0);
        assert_eq!(out.tunnels_opened, out.tunnels_settled, "synchronous build: opened == settled");
    }

    #[test]
    fn deterministic_mode_is_constant_143() {
        let out = run_simple(2, 3600, Some(50), CardMode::Deterministic);
        assert_eq!(out.moves, 143 * 50);
        assert_eq!(out.moves_dist.min, 143.0);
        assert_eq!(out.moves_dist.peak, 143.0);
    }
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench swarm`
Expected: FAIL (compile error — `CardMode` undefined, runner arity, missing `SwarmOutcome` fields).

- [ ] **Step 3: Add `CardMode`, extend `SwarmOutcome`, and the `MatchSample` type**

In `tools/rustbench/src/fleet/swarm.rs`, add near the top (after the `use` lines):
```rust
use crate::fleet::stats::{summarize, Distribution};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CardMode {
    Varied,
    Deterministic,
}

impl CardMode {
    /// The per-match card seed: distinct per match when varied, `None` (the
    /// golden stream) when deterministic.
    fn seed(self, match_index: u64) -> Option<u64> {
        match self {
            CardMode::Varied => Some(match_index),
            CardMode::Deterministic => None,
        }
    }
}

/// One completed match's measurements.
#[derive(Clone, Copy)]
struct MatchSample {
    moves: u64,
    bytes: u64,
    play_ns: u128,
    total_ns: u128,
}
```
Extend `SwarmOutcome` (keep all current fields, add the new ones):
```rust
#[derive(Clone, Debug)]
pub struct SwarmOutcome {
    pub moves: u64,
    pub bytes: u64,
    pub tunnels_settled: u64,
    pub tunnels_opened: u64,
    pub matches_claimed: u64,
    pub elapsed_ms: u128,
    pub play_ns_total: u128,
    pub total_ns_total: u128,
    pub moves_dist: Distribution,
    pub play_ns_dist: Distribution,
}
```

- [ ] **Step 4: Rewrite `run_with` to collect per-worker samples**

Replace the `Counters` struct and `run_with` body in `tools/rustbench/src/fleet/swarm.rs` with a per-worker-Vec design. The claim/cap/deadline logic is unchanged; only accumulation changes (samples instead of atomics, merged after the scope):
```rust
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Core fleet loop, generic over the per-match runner. `run_match(match_index)`
/// runs one full match and returns its sample.
pub(crate) fn run_with<F>(
    workers: usize,
    duration_secs: u64,
    matches: Option<u64>,
    run_match: F,
) -> SwarmOutcome
where
    F: Fn(u64) -> MatchSample + Sync,
{
    let claimed = AtomicU64::new(0);
    let stop = AtomicBool::new(false);
    let collected: Mutex<Vec<MatchSample>> = Mutex::new(Vec::new());

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()
        .expect("rayon pool");
    let start = Instant::now();
    let deadline = start + Duration::from_secs(duration_secs);

    pool.scope(|s| {
        for _ in 0..workers {
            s.spawn(|_| {
                let mut local: Vec<MatchSample> = Vec::new();
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    if Instant::now() >= deadline {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                    let idx = claimed.fetch_add(1, Ordering::Relaxed);
                    if let Some(cap) = matches {
                        if idx >= cap {
                            stop.store(true, Ordering::Relaxed);
                            break;
                        }
                    }
                    local.push(run_match(idx));
                }
                collected.lock().expect("collect").extend(local);
            });
        }
    });

    let elapsed_ms = start.elapsed().as_millis();
    let samples = collected.into_inner().expect("samples");
    let tunnels_settled = samples.len() as u64;
    let matches_claimed = matches
        .map(|cap| tunnels_settled.min(cap))
        .unwrap_or(tunnels_settled);
    let moves: u64 = samples.iter().map(|s| s.moves).sum();
    let bytes: u64 = samples.iter().map(|s| s.bytes).sum();
    let play_ns_total: u128 = samples.iter().map(|s| s.play_ns).sum();
    let total_ns_total: u128 = samples.iter().map(|s| s.total_ns).sum();
    let moves_dist = summarize(&samples.iter().map(|s| s.moves as f64).collect::<Vec<_>>());
    let play_ns_dist = summarize(&samples.iter().map(|s| s.play_ns as f64).collect::<Vec<_>>());

    SwarmOutcome {
        moves,
        bytes,
        tunnels_settled,
        tunnels_opened: tunnels_settled, // synchronous build never abandons a started match
        matches_claimed,
        elapsed_ms,
        play_ns_total,
        total_ns_total,
        moves_dist,
        play_ns_dist,
    }
}
```
Remove the now-unused `Counters` struct and any stale `use` of `AtomicU64`/`AtomicBool` that this block does not already declare (the block above re-declares the imports it needs — delete duplicates).

- [ ] **Step 5: Update the three runners to take `CardMode` and time the whole match**

Each runner times the full match (setup + play) for `total_ns` and reads `play_ns` from the result:
```rust
pub fn run_simple(workers: usize, duration_secs: u64, matches: Option<u64>, mode: CardMode) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |idx| {
        let t = Instant::now();
        let r = play_fixed_match_seeded(
            mode.seed(idx), &tunnel_id_for(idx), &SEAT_A, &SEAT_B, 200, 200, CREATED_AT, MAX_MOVES,
        );
        MatchSample { moves: r.moves, bytes: r.bytes as u64, play_ns: r.play_ns, total_ns: t.elapsed().as_nanos() }
    })
}

pub fn run_fresh_keys(workers: usize, duration_secs: u64, matches: Option<u64>, mode: CardMode) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |idx| {
        let mut secret_a = [0u8; 32];
        let mut secret_b = [0u8; 32];
        getrandom::getrandom(&mut secret_a).expect("os rng");
        getrandom::getrandom(&mut secret_b).expect("os rng");
        let t = Instant::now();
        let r = play_fixed_match_seeded(
            mode.seed(idx), &tunnel_id_for(idx), &secret_a, &secret_b, 200, 200, CREATED_AT, MAX_MOVES,
        );
        MatchSample { moves: r.moves, bytes: r.bytes as u64, play_ns: r.play_ns, total_ns: t.elapsed().as_nanos() }
    })
}

pub fn run_optimized(workers: usize, duration_secs: u64, matches: Option<u64>, mode: CardMode) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |idx| {
        thread_local! {
            static KIT: SeatKit = SeatKit::new(&SEAT_A, &SEAT_B);
        }
        KIT.with(|kit| {
            let t = Instant::now();
            let r = play_prepared_seeded(mode.seed(idx), kit, &tunnel_id_for(idx), 200, 200, CREATED_AT, MAX_MOVES);
            MatchSample { moves: r.moves, bytes: r.bytes as u64, play_ns: r.play_ns, total_ns: t.elapsed().as_nanos() }
        })
    })
}
```
Update the `use crate::driver::{…}` line to import `play_fixed_match_seeded, play_prepared_seeded, SeatKit` (drop unused `play_fixed_match`/`play_prepared`/`play_prepared` if clippy flags them).

- [ ] **Step 6: Keep `main.rs` and `report.rs` compiling (stopgaps)**

The 4-arg runner signatures break `main.rs` (it calls the 3-arg forms). Update `tools/rustbench/src/main.rs`: change `run_headline`'s type and both calls to the 4-arg form, passing the literal `swarm::CardMode::Varied` for now (Task 6 replaces it with `opts.card_mode`):
```rust
    let run_headline: fn(usize, u64, Option<u64>, swarm::CardMode) -> swarm::SwarmOutcome =
        if opts.fresh_keys { swarm::run_fresh_keys } else { swarm::run_simple };
```
and pass `swarm::CardMode::Varied` as the final argument to every `run_headline(...)` and `swarm::run_optimized(...)` call. Leave `resources::start(250)` as-is (Task 5 changes it).

In `tools/rustbench/src/report.rs`, the test `outcome(...)` helper constructs a `SwarmOutcome` literal — add the new fields so it compiles: `tunnels_opened: matches, play_ns_total: 0, total_ns_total: 0, moves_dist: crate::fleet::stats::Distribution::default(), play_ns_dist: crate::fleet::stats::Distribution::default()`. Task 6 gives them real values for the new golden-line tests.

- [ ] **Step 7: Run swarm tests + full suite**

Run: `cargo test -p rustbench`
Expected: PASS — deterministic totals (143*N), the new varied/deterministic tests, the golden gate, and the existing `render_*` tests (they read the unchanged headline fields).

- [ ] **Step 8: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench --all-targets -- -D warnings
git add tools/rustbench/src/fleet/swarm.rs tools/rustbench/src/main.rs tools/rustbench/src/report.rs
git commit -m "feat(rustbench): per-match samples, card mode, distributions"
```

---

### Task 5: cgroup-aware CPU budget + resource percentiles

**Files:**
- Create: `tools/rustbench/src/fleet/cgroup.rs`
- Modify: `tools/rustbench/src/fleet/resources.rs` (per-sample vectors → distributions; cgroup denominator; thread count)
- Modify: `tools/rustbench/src/fleet/mod.rs` (`pub mod cgroup;`)
- Modify: `tools/rustbench/src/main.rs` (update the `resources::start(250)` calls to the new 2-arg form so the binary compiles)
- Test: in-file `#[cfg(test)]` in `cgroup.rs` and `resources.rs`

**Interfaces:**
- Produces:
  - `cgroup::parse_v2_quota(cpu_max: &str) -> Option<f64>` — `"<quota> <period>"` ⇒ `quota/period`; `"max …"` ⇒ `None`.
  - `cgroup::cpu_budget() -> CpuBudget` where `pub struct CpuBudget { pub cores: f64, pub basis: CpuBasis }`, `pub enum CpuBasis { Cgroup, System }`.
  - `resources::ResourceSummary` gains: `pub threads: u64`, `pub cpu_util_avg_pct: f64`, `pub cpu_util_p50_pct: f64`, `pub cpu_util_p99_pct: f64`, `pub cpu_util_peak_pct: f64`, `pub rss_p50_bytes: f64`, `pub basis: &'static str`. `start` gains a `threads: usize` parameter: `start(interval_ms: u64, threads: usize) -> ResourceSampler`.

- [ ] **Step 1: Write the failing cgroup tests**

Create `tools/rustbench/src/fleet/cgroup.rs` with the test module first:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_quota_fraction() {
        assert_eq!(parse_v2_quota("800000 1000000"), Some(0.8));
        assert_eq!(parse_v2_quota("2000000 1000000"), Some(2.0));
    }

    #[test]
    fn v2_unlimited_is_none() {
        assert_eq!(parse_v2_quota("max 1000000"), None);
        assert_eq!(parse_v2_quota(""), None);
    }

    #[test]
    fn budget_is_positive() {
        let b = cpu_budget();
        assert!(b.cores >= 1.0, "fallback core count must be >= 1");
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench cgroup`
Expected: FAIL (compile error — `parse_v2_quota`, `cpu_budget` undefined).

- [ ] **Step 3: Implement `cgroup.rs`**

Insert at the TOP of `tools/rustbench/src/fleet/cgroup.rs`:
```rust
//! Cross-platform CPU "assigned cores" denominator. Inside a `docker run --cpus N`
//! (cgroup v2/v1) the quota is the truth; otherwise the host core count. Mirrors
//! loadbench's resourceMonitor cgroup logic so in-container utilization reads
//! against the assigned cores, not the host.

use std::fs;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CpuBasis {
    Cgroup,
    System,
}

#[derive(Clone, Copy, Debug)]
pub struct CpuBudget {
    pub cores: f64,
    pub basis: CpuBasis,
}

/// Parse cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>") into assigned
/// cores, or `None` if unlimited / unparseable.
pub fn parse_v2_quota(cpu_max: &str) -> Option<f64> {
    let mut it = cpu_max.split_whitespace();
    let quota = it.next()?;
    if quota == "max" {
        return None;
    }
    let q: f64 = quota.parse().ok()?;
    let p: f64 = it.next()?.parse().ok()?;
    if q > 0.0 && p > 0.0 {
        Some(q / p)
    } else {
        None
    }
}

/// Cores assigned by the cgroup CPU quota (v2 then v1), or `None` if unlimited /
/// not in a cgroup.
fn cgroup_quota_cores() -> Option<f64> {
    if let Ok(s) = fs::read_to_string("/sys/fs/cgroup/cpu.max") {
        return parse_v2_quota(&s);
    }
    let q: f64 = fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let p: f64 = fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    if q > 0.0 && p > 0.0 {
        Some(q / p)
    } else {
        None
    }
}

/// The cores the bench may use, and how it was determined.
pub fn cpu_budget() -> CpuBudget {
    if let Some(q) = cgroup_quota_cores() {
        if q > 0.0 {
            return CpuBudget {
                cores: (q * 100.0).round() / 100.0,
                basis: CpuBasis::Cgroup,
            };
        }
    }
    let cores = std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(1.0);
    CpuBudget {
        cores,
        basis: CpuBasis::System,
    }
}
```

- [ ] **Step 4: Register the module**

In `tools/rustbench/src/fleet/mod.rs`, add:
```rust
pub mod cgroup;
```

- [ ] **Step 5: Extend the resource sampler**

In `tools/rustbench/src/fleet/resources.rs`: add `use crate::fleet::cgroup::cpu_budget;` and `use crate::fleet::stats::summarize;`. Change `start` to `pub fn start(interval_ms: u64, threads: usize) -> ResourceSampler` and store `threads` in the sampler so `sample_loop` can put it on the summary. In `sample_loop`, accumulate per-sample vectors `cores_samples: Vec<f64>`, `util_pct_samples: Vec<f64>`, `rss_samples: Vec<f64>` (utilization% = `cores / budget.cores * 100`, where `budget = cpu_budget()` read once), and at the end build the summary using `summarize(&…)` for the utilization and RSS distributions plus `cores_avg`/`cores_peak` as today. Add the new fields to `ResourceSummary`:
```rust
    pub threads: u64,
    pub cpu_util_avg_pct: f64,
    pub cpu_util_p50_pct: f64,
    pub cpu_util_p99_pct: f64,
    pub cpu_util_peak_pct: f64,
    pub rss_p50_bytes: f64,
    pub basis: &'static str,
```
Set `basis` from `cpu_budget().basis` (`"cgroup"` or `"system"`). Keep the existing `cpu_cores_avg`/`cpu_cores_peak`/`rss_avg_bytes`/`rss_peak_bytes`/`samples` fields. Update the existing `sampler_yields_a_sane_summary` test to call `start(50, 4)` and additionally assert `s.threads == 4` and `s.cpu_util_avg_pct >= 0.0 && s.cpu_util_avg_pct.is_finite()`.

- [ ] **Step 6: Keep `main.rs` compiling (start arity)**

The new `start(interval_ms, threads)` signature breaks `main.rs`. Update every `resources::start(250)` call in `tools/rustbench/src/main.rs` to `resources::start(250, opts.workers)`.

- [ ] **Step 7: Run resource + cgroup tests + full suite**

Run: `cargo test -p rustbench`
Expected: PASS, including `cgroup`, `resources`, `sampler_yields_a_sane_summary`, and the golden gate. (On macOS, `basis` is `"system"`; the cgroup parse tests are pure-string and pass everywhere.)

- [ ] **Step 8: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench --all-targets -- -D warnings
git add tools/rustbench/src/fleet/cgroup.rs tools/rustbench/src/fleet/resources.rs tools/rustbench/src/fleet/mod.rs tools/rustbench/src/main.rs
git commit -m "feat(rustbench): cgroup-aware cpu budget + resource percentiles"
```

---

### Task 6: CLI defaults + report rendering + main wiring

**Files:**
- Modify: `tools/rustbench/src/cli.rs` (`--fixed-keys`, `--deterministic`; `BenchOpts`)
- Modify: `tools/rustbench/src/report.rs` (render new metric blocks)
- Modify: `tools/rustbench/src/main.rs` (pass `CardMode`, fresh/fixed, render)
- Test: in-file `#[cfg(test)]` in `cli.rs` and `report.rs`

**Interfaces:**
- Consumes: `swarm::{SwarmOutcome, CardMode}`, `resources::ResourceSummary`.
- Produces:
  - `BenchOpts { …, pub fresh_keys: bool, pub card_mode: swarm::CardMode }` (the old `fresh_keys` field stays; `card_mode` added). `--fixed-keys` sets `fresh_keys=false` (default `true`); `--deterministic` sets `card_mode=Deterministic` (default `Varied`).
  - `report::render(opts, simple, optimized, res)` extended to print the new lines.

- [ ] **Step 1: Update CLI tests for the new defaults**

In `tools/rustbench/src/cli.rs` tests, replace `fresh_keys_flag_parses_and_defaults_off` with:
```rust
    #[test]
    fn fresh_keys_is_default_on_and_fixed_keys_opts_out() {
        assert!(parse_v(&["--runner", "simple"]).unwrap().fresh_keys);
        assert!(!parse_v(&["--runner", "simple", "--fixed-keys"]).unwrap().fresh_keys);
    }

    #[test]
    fn gameplay_is_varied_by_default_and_deterministic_opts_in() {
        use crate::fleet::swarm::CardMode;
        assert_eq!(parse_v(&["--runner", "simple"]).unwrap().card_mode, CardMode::Varied);
        assert_eq!(
            parse_v(&["--runner", "simple", "--deterministic"]).unwrap().card_mode,
            CardMode::Deterministic
        );
    }
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench cli`
Expected: FAIL (compile error — `--fixed-keys`/`--deterministic`/`card_mode` not defined).

- [ ] **Step 3: Update `cli.rs`**

Replace the `fresh_keys` field on `Raw` with `fixed_keys` and add `deterministic`:
```rust
    /// Use fixed seat keys (opt out of the default fresh-per-match keygen).
    #[arg(long)]
    fixed_keys: bool,
    /// Replay the fixed golden 143-move match every time (opt out of varied cards).
    #[arg(long)]
    deterministic: bool,
```
Add `pub card_mode: crate::fleet::swarm::CardMode` to `BenchOpts` (keep `pub fresh_keys: bool`). In `parse`, set:
```rust
        fresh_keys: !raw.fixed_keys,
        card_mode: if raw.deterministic {
            crate::fleet::swarm::CardMode::Deterministic
        } else {
            crate::fleet::swarm::CardMode::Varied
        },
```

- [ ] **Step 4: Update the `report.rs` test helper + add golden lines**

In `tools/rustbench/src/report.rs` tests, update the `opts(...)` helper to include `fresh_keys: true, card_mode: crate::fleet::swarm::CardMode::Deterministic`, and update the `outcome(...)` helper to construct the new `SwarmOutcome` fields (`tunnels_opened: matches, play_ns_total, total_ns_total`, and `moves_dist`/`play_ns_dist` via `crate::fleet::stats::summarize`). Add a golden-string test asserting the new lines render in deterministic mode (e.g. a `moves/match` line and a `play-only move-TPS` line). Keep the existing `render_*` assertions for the headline lines.

- [ ] **Step 5: Extend `render`**

In `tools/rustbench/src/report.rs`, add lines to the `render` output for: tunnels opened/settled, matches conducted, moves-per-match (`avg/p50/p90/p99/peak`), setup overhead % (`(total_ns_total - play_ns_total) / total_ns_total * 100`), play-only move-TPS (`move_tps(simple.moves, simple.elapsed_ms) * (total_ns_total as f64 / play_ns_total as f64)`), play-loop duration (`avg/p50/p99` from `play_ns_dist`, rendered in µs), and the resources line additions (threads, util p50/p99, basis). All lines keep the `[local/offchain]` prefix. Guard against `play_ns_total == 0` (return the wall TPS unscaled).

- [ ] **Step 6: Wire `main.rs` to the flag**

In `tools/rustbench/src/main.rs`, replace the `swarm::CardMode::Varied` stopgaps (placed in Task 4) with `opts.card_mode` in every `run_headline(...)` and `swarm::run_optimized(...)` call. The `run_headline` fn-pointer type (4-arg) and the `resources::start(250, opts.workers)` calls are already in place from Tasks 4 and 5 — no other change needed.

- [ ] **Step 7: Run full suite + manual check**

Run: `cargo test -p rustbench`
Expected: PASS (all unit + integration + golden gate). Then:
```bash
cargo run -p rustbench --release -- --offchain --channel local --game blackjack --duration 2 --runner simple
```
Expected: the new metric lines print; with the default (fresh keys, varied) the moves-per-match `peak > min`.

- [ ] **Step 8: fmt + clippy + commit**

```bash
cargo fmt -p rustbench
cargo clippy -p rustbench --all-targets -- -D warnings
git add tools/rustbench/src/cli.rs tools/rustbench/src/report.rs tools/rustbench/src/main.rs
git commit -m "feat(rustbench): fresh+varied defaults, rich report"
```

---

### Task 7: Container image

**Files:**
- Create: `tools/rustbench/Dockerfile`
- Test: manual `docker build` (documented; not run in CI)

**Interfaces:**
- Produces: a `rustbench` image whose entrypoint is the binary, so `docker run --cpus N --memory M rustbench <flags>` runs the bench with cgroup-correct CPU accounting (Task 5).

- [ ] **Step 1: Write the Dockerfile**

Create `tools/rustbench/Dockerfile` (build context is the repo root, so the whole workspace is available for the build):
```dockerfile
# Multi-stage: compile the release binary, then ship a slim runtime.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build -p rustbench --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/rustbench /usr/local/bin/rustbench
ENTRYPOINT ["rustbench"]
CMD ["--offchain", "--channel", "local", "--game", "blackjack"]
```

- [ ] **Step 2: Document usage (verification is manual)**

This task has no automated test (CI has no Docker). Verify manually if Docker is available:
```bash
docker build -t rustbench -f tools/rustbench/Dockerfile .
docker run --cpus 4 --memory 2g rustbench --duration 3 --runner simple
```
Expected: the report prints and the `resources` line shows `basis=cgroup` with utilization measured against ~4 cores. If Docker is unavailable, confirm the Dockerfile parses (`docker build --check` or visual review) and note it in the report.

- [ ] **Step 3: Commit**

```bash
git add tools/rustbench/Dockerfile
git commit -m "build(rustbench): container image for pinned-cpu runs"
```

---

## Verification of the whole plan

- The Plan 2 parity gate (`fixed_match_matches_ts_golden`) passes **with its call site unchanged** — deterministic is the default of the public `play_fixed_match`/`play_prepared`.
- `--deterministic --workers 1 --matches N` ⇒ `143*N` moves, `75982*N` bytes, `N` tunnels (the regression gate; runs in deterministic mode).
- The default run (`--offchain --channel local --game blackjack`) uses fresh keys + varied cards and prints: tunnels opened/settled, matches conducted, moves-per-match distribution, wall move-TPS, setup overhead %, play-only move-TPS, play-loop duration distribution, CPU cores + utilization percentiles with `basis`, thread count, and RSS — all `[local/offchain]`-prefixed.
- Inside `docker run --cpus N`, the resources line reports `basis=cgroup` and utilization against N.

## Follow-on (not in this plan)

- Relay channel, on-chain anchor, `--game all` multi-game markdown table.
- Per-move (not per-match) latency timestamps.
- A compose file / CI job that runs the container under a fixed `--cpus`.
