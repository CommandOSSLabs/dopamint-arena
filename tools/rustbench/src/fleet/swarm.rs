//! The synchronous CPU fleet. Each rayon worker claims the next match index,
//! runs one full match through the gate-verified `play_fixed_match`, and folds
//! its moves/bytes/tunnels into shared atomics until the stop condition fires.
//! Total work under `--matches N` is exact (143*N moves), which is the
//! deterministic regression gate; `--duration` is the time-bounded throughput
//! mode.

use crate::driver::play_fixed_match;
use crate::driver::{play_prepared, SeatKit};
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
        let r = play_fixed_match(
            &tunnel_id, &SEAT_A, &SEAT_B, 200, 200, CREATED_AT, MAX_MOVES,
        );
        (r.moves, r.bytes as u64)
    })
}

/// Apples-to-apples-with-loadbench fleet: generates two fresh ed25519 keypairs
/// per match (mirroring loadbench's per-match `generateKeyPairSync`) inside the
/// timed window, then derives their public keys via `play_fixed_match`. The
/// efficient binary codec and native crypto stay; only the *harness* shape
/// (fresh per-match key setup) is matched to loadbench. Gameplay is unchanged
/// (cards derive from `round`), so totals stay 143*N moves / 75982*N bytes.
pub fn run_fresh_keys(workers: usize, duration_secs: u64, matches: Option<u64>) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |tunnel_id| {
        let mut secret_a = [0u8; 32];
        let mut secret_b = [0u8; 32];
        getrandom::getrandom(&mut secret_a).expect("os rng");
        getrandom::getrandom(&mut secret_b).expect("os rng");
        let r = play_fixed_match(
            &tunnel_id, &secret_a, &secret_b, 200, 200, CREATED_AT, MAX_MOVES,
        );
        (r.moves, r.bytes as u64)
    })
}

/// Optimized fleet: each worker caches one `SeatKit` and runs `play_prepared`.
pub fn run_optimized(workers: usize, duration_secs: u64, matches: Option<u64>) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |tunnel_id| {
        thread_local! {
            static KIT: SeatKit = SeatKit::new(&SEAT_A, &SEAT_B);
        }
        KIT.with(|kit| {
            let r = play_prepared(kit, &tunnel_id, 200, 200, CREATED_AT, MAX_MOVES);
            (r.moves, r.bytes as u64)
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_keys_runner_conserves_totals() {
        // Fresh per-match keys don't change gameplay (cards derive from round),
        // so the deterministic gate holds: exactly 143*N moves, 75982*N bytes.
        let out = run_fresh_keys(2, 3600, Some(6));
        assert_eq!(out.matches_claimed, 6);
        assert_eq!(out.tunnels_settled, 6);
        assert_eq!(out.moves, 143 * 6);
        assert_eq!(out.bytes, 75982 * 6);
    }

    #[test]
    fn optimized_runner_matches_simple_totals() {
        let simple = run_simple(2, 3600, Some(8));
        let optimized = run_optimized(2, 3600, Some(8));
        assert_eq!(optimized.moves, simple.moves);
        assert_eq!(optimized.bytes, simple.bytes);
        assert_eq!(optimized.tunnels_settled, simple.tunnels_settled);
    }

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
