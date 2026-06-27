//! The synchronous CPU fleet. Each rayon worker claims the next match index,
//! runs one full match through the gate-verified `play_fixed_match_seeded`, and
//! folds its measurements into a per-worker Vec; Vecs are merged after the
//! rayon scope so there is no atomic contention on the hot path.
//! Total work under `--matches N` with `CardMode::Deterministic` is exact
//! (143*N moves), which is the deterministic regression gate; `--duration` is
//! the time-bounded throughput mode.

use crate::cli::CodecKind;
use crate::driver::{play_match_seeded, SeatKit};
use crate::stats::{summarize, Distribution};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tunnel_harness::{BcsFrameCodec, JsonFrameCodec, PostcardFrameCodec};

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

/// Run one match through the codec selected at the CLI. Static dispatch keeps
/// codec cost on the measured path with one monomorphized driver per arm.
fn play_match_for(
    codec: CodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
) -> crate::driver::MatchResult {
    match codec {
        CodecKind::Json => play_match_seeded::<JsonFrameCodec>(
            card_seed, kit, tunnel_id, 200, 200, CREATED_AT, MAX_MOVES,
        ),
        CodecKind::Bcs => play_match_seeded::<BcsFrameCodec>(
            card_seed, kit, tunnel_id, 200, 200, CREATED_AT, MAX_MOVES,
        ),
        CodecKind::Postcard => play_match_seeded::<PostcardFrameCodec>(
            card_seed, kit, tunnel_id, 200, 200, CREATED_AT, MAX_MOVES,
        ),
    }
}

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
pub(crate) struct MatchSample {
    moves: u64,
    bytes: u64,
    play_ns: u128,
    total_ns: u128,
}

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

/// Distinct, valid hex tunnel id per match (offset by 1 to avoid the all-zero address).
pub fn tunnel_id_for(match_index: u64) -> String {
    format!("0x{:x}", match_index + 1)
}

/// Core fleet loop, generic over the per-match runner.
/// `run_match(match_index)` runs one full match and returns its sample.
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

pub fn run_simple(
    workers: usize,
    duration_secs: u64,
    matches: Option<u64>,
    mode: CardMode,
    codec: CodecKind,
) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |idx| {
        let t = Instant::now();
        let kit = SeatKit::new(&SEAT_A, &SEAT_B);
        let r = play_match_for(codec, mode.seed(idx), &kit, &tunnel_id_for(idx));
        MatchSample {
            moves: r.moves,
            bytes: r.bytes as u64,
            play_ns: r.play_ns,
            total_ns: t.elapsed().as_nanos(),
        }
    })
}

/// Apples-to-apples-with-loadbench fleet: generates two fresh ed25519 keypairs
/// per match (mirroring loadbench's per-match `generateKeyPairSync`) inside the
/// timed window, then derives their public keys via `play_fixed_match_seeded`.
/// The efficient binary codec and native crypto stay; only the *harness* shape
/// (fresh per-match key setup) is matched to loadbench. With
/// `CardMode::Deterministic`, cards derive from `round`, so totals stay
/// 143*N moves / 75982*N bytes.
pub fn run_fresh_keys(
    workers: usize,
    duration_secs: u64,
    matches: Option<u64>,
    mode: CardMode,
    codec: CodecKind,
) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |idx| {
        let mut secret_a = [0u8; 32];
        let mut secret_b = [0u8; 32];
        getrandom::getrandom(&mut secret_a).expect("os rng");
        getrandom::getrandom(&mut secret_b).expect("os rng");
        let t = Instant::now();
        let kit = SeatKit::new(&secret_a, &secret_b);
        let r = play_match_for(codec, mode.seed(idx), &kit, &tunnel_id_for(idx));
        MatchSample {
            moves: r.moves,
            bytes: r.bytes as u64,
            play_ns: r.play_ns,
            total_ns: t.elapsed().as_nanos(),
        }
    })
}

/// Optimized fleet: each worker caches one `SeatKit` and runs
/// `play_prepared_seeded`.
pub fn run_optimized(
    workers: usize,
    duration_secs: u64,
    matches: Option<u64>,
    mode: CardMode,
    codec: CodecKind,
) -> SwarmOutcome {
    run_with(workers, duration_secs, matches, |idx| {
        thread_local! {
            static KIT: SeatKit = SeatKit::new(&SEAT_A, &SEAT_B);
        }
        KIT.with(|kit| {
            let t = Instant::now();
            let r = play_match_for(codec, mode.seed(idx), kit, &tunnel_id_for(idx));
            MatchSample {
                moves: r.moves,
                bytes: r.bytes as u64,
                play_ns: r.play_ns,
                total_ns: t.elapsed().as_nanos(),
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_keys_runner_conserves_totals() {
        // Fresh per-match keys don't change gameplay (cards derive from round),
        // so the deterministic gate holds: exactly 143*N moves, 75982*N bytes.
        let out = run_fresh_keys(2, 3600, Some(6), CardMode::Deterministic, CodecKind::Json);
        assert_eq!(out.matches_claimed, 6);
        assert_eq!(out.tunnels_settled, 6);
        assert_eq!(out.moves, 143 * 6);
        assert_eq!(out.bytes, 75982 * 6);
    }

    #[test]
    fn optimized_runner_matches_simple_totals() {
        let simple = run_simple(2, 3600, Some(8), CardMode::Deterministic, CodecKind::Json);
        let optimized = run_optimized(2, 3600, Some(8), CardMode::Deterministic, CodecKind::Json);
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
        let out = run_simple(1, 3600, Some(5), CardMode::Deterministic, CodecKind::Json);
        assert_eq!(out.matches_claimed, 5);
        assert_eq!(out.tunnels_settled, 5);
        assert_eq!(out.moves, 143 * 5);
        assert_eq!(out.bytes, 75982 * 5);
    }

    #[test]
    fn multi_worker_conserves_totals() {
        // Total work is fixed by --matches regardless of worker count.
        let out = run_simple(4, 3600, Some(20), CardMode::Deterministic, CodecKind::Json);
        assert_eq!(out.matches_claimed, 20);
        assert_eq!(out.tunnels_settled, 20);
        assert_eq!(out.moves, 143 * 20);
        assert_eq!(out.bytes, 75982 * 20);
    }

    #[test]
    fn varied_mode_produces_a_nondegenerate_move_distribution() {
        let out = run_simple(2, 3600, Some(200), CardMode::Varied, CodecKind::Json);
        assert_eq!(out.tunnels_settled, 200);
        assert_eq!(out.matches_claimed, 200);
        // Varied cards => not every match is 143 moves.
        assert!(
            out.moves_dist.peak > out.moves_dist.min,
            "moves should vary: {:?}",
            out.moves_dist
        );
        assert!(out.play_ns_total > 0);
        assert_eq!(
            out.tunnels_opened, out.tunnels_settled,
            "synchronous build: opened == settled"
        );
    }

    #[test]
    fn deterministic_mode_is_constant_143() {
        let out = run_simple(2, 3600, Some(50), CardMode::Deterministic, CodecKind::Json);
        assert_eq!(out.moves, 143 * 50);
        assert_eq!(out.moves_dist.min, 143.0);
        assert_eq!(out.moves_dist.peak, 143.0);
    }

    #[test]
    fn codec_choice_is_consensus_invisible() {
        let json = run_simple(2, 3600, Some(8), CardMode::Deterministic, CodecKind::Json);
        let bcs = run_simple(2, 3600, Some(8), CardMode::Deterministic, CodecKind::Bcs);
        let postcard = run_simple(
            2,
            3600,
            Some(8),
            CardMode::Deterministic,
            CodecKind::Postcard,
        );

        assert_eq!(bcs.moves, json.moves);
        assert_eq!(postcard.moves, json.moves);
        assert_eq!(bcs.tunnels_settled, json.tunnels_settled);
        assert_eq!(postcard.tunnels_settled, json.tunnels_settled);
        assert!(bcs.bytes < json.bytes && postcard.bytes < json.bytes);
    }
}
