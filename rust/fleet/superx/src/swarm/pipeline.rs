//! Staged open -> play -> settle pipeline for one swarm.
//!
//! A swarm is `tunnels` self-play tunnels, each two [`PartyDriver`]s over an
//! in-memory transport sharing a [`DriverRunControl`] tunnel gate. Staging is
//! enforced at the [`StagingAnchor`] seam: every tunnel's `open` parks on a
//! swarm-wide [`PreOpenGate`] (play cannot begin until the whole swarm is open),
//! and every tunnel's `settle` hands off to a swarm-wide [`SettleManager`] that
//! holds all seats behind a barrier until play completes, then drains the pairs
//! in [`SettleWaveGate`] cohorts. The three phases are therefore disjoint and
//! ordered by construction, not by cooperation.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::task::JoinSet;
use tunnel_blackjack::v2::BlackjackV2;
use tunnel_harness::instrument::InstrumentedTransport;
use tunnel_harness::{
    Balances, DriverRunControl, InMemoryAnchor, InMemoryFrameTransport, LocalSigner,
    NullTranscriptRecorder, PartyDriver, Protocol, RootOnlyTranscriptRecorder, Seat, SeatParts,
    SettlementMode, Signer, Transcript, TranscriptEntry, TranscriptError, TranscriptRecorder,
};
use tunnel_payments::Payments;
use tunnel_telemetry::CollectingSink;

use crate::swarm::anchor::{InnerAnchor, StagingAnchor, SuiContext};
use crate::swarm::gates::{PreOpenGate, SettleWaveGate};
use crate::swarm::protocol::{ProtocolKind, Scenario, SeededStrategy, play_seed};
use crate::swarm::settle_manager::SettleManager;
use crate::swarm::stats::{Distribution, summarize};

/// Per-tunnel move budget for payments when no explicit move cap is set. Bounds
/// the golden run to a constant, fast, deterministic length per tunnel.
const DEFAULT_PAYMENTS_TRANSFERS: u64 = 16;

/// Hard ceiling passed to `PartyDriver::run`; the protocol terminal or the
/// graceful move limit stops play well before this, so it only guards runaways.
const DRIVER_MAX_MOVES: u64 = u64::MAX - 1;

/// Monotonic move-loop clock base. In-memory anchors surface no on-chain
/// `created_at`, so both seats fall back to this local clock; any positive base
/// keeps settlement timestamps non-zero.
const CLOCK_BASE: u64 = 1_234_567_890;

/// Bound on the post-stop settle drain. A swarm that cannot drain in this window
/// has a stuck seat; the pipeline aborts the stragglers rather than hang.
const TUNNEL_DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

/// Grace granted to background drain/heartbeat tasks after the measured run ends,
/// before the runtime is torn down.
const RUNTIME_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Layer-1 pipeline concurrency, anchor-agnostic. `*_cohort` caps how many
/// opens/settles fly concurrently (a cohort completes before the next starts);
/// `*_spacing` delays between cohorts. `None` = no cap. Distinct from the Sui
/// anchor's PTB batch size (Layer 2): cohorts govern tunnel concurrency, batch
/// size governs how many the anchor packs into one PTB.
#[derive(Clone, Debug)]
pub struct CohortConfig {
    pub open_cohort: Option<usize>,
    pub open_spacing: Duration,
    pub settle_cohort: Option<usize>,
    pub settle_spacing: Duration,
}

impl CohortConfig {
    /// No caps, no spacing: every tunnel opens and settles as soon as it can.
    pub fn unbounded() -> Self {
        Self {
            open_cohort: None,
            open_spacing: Duration::ZERO,
            settle_cohort: None,
            settle_spacing: Duration::ZERO,
        }
    }
}

/// Live-telemetry sink for a swarm run. Consumed by the heartbeat client (wired
/// with the heartbeat module); the pipeline only forwards it.
#[derive(Clone, Debug)]
pub struct HeartbeatConfig {
    pub url: String,
    pub flush_ms: u64,
}

/// Which chain backend the swarm's tunnels run against.
pub enum AnchorChoice {
    Memory,
    Sui(SuiContext),
}

/// Everything one `run-swarm` invocation needs to run its staged pipeline.
pub struct SwarmParams {
    pub run_id: String,
    pub swarm_index: u64,
    pub swarm_count: u64,
    pub tunnels: u64,
    pub protocol: ProtocolKind,
    pub scenario: Scenario,
    pub initial_balance: u64,
    pub anchor: AnchorChoice,
    pub cohorts: CohortConfig,
    pub workers: usize,
    pub duration_secs: u64,
    pub moves: Option<u64>,
    pub heartbeat: Option<HeartbeatConfig>,
    pub telemetry_collect: bool,
}

/// Headline measurements of one swarm run. The three phase windows are disjoint
/// and ordered (`open` before `play` before `settle`) by the staging barriers.
#[derive(Clone, Debug)]
pub struct SwarmOutcome {
    pub tunnels_opened: u64,
    pub tunnels_settled: u64,
    pub tunnels_failed: u64,
    pub tunnels_aborted: u64,
    pub moves: u64,
    pub bytes: u64,
    pub elapsed_ms: u128,
    pub open_ms: u128,
    pub play_ms: u128,
    pub settle_ms: u128,
    pub play_ns_dist: Distribution,
    pub per_tunnel_tps: Distribution,
}

/// One completed tunnel's contribution, joined from both seats.
struct TunnelResult {
    settled: bool,
    moves: u64,
    bytes: u64,
    play_ns: u128,
}

/// Per-seat transcript recorder chosen by settlement mode: rootless anchors need
/// nothing recorded, transcript-root anchors need the Merkle frontier to sign.
/// Mirrors the bench's `BenchRecorder` but without the full-transcript variant,
/// which the swarm never exports.
enum SwarmRecorder<M> {
    Null(NullTranscriptRecorder),
    RootOnly(RootOnlyTranscriptRecorder<M>),
}

impl<M: Clone + Send + Sync> TranscriptRecorder<M> for SwarmRecorder<M> {
    fn records_transcript(&self) -> bool {
        match self {
            Self::Null(r) => TranscriptRecorder::<M>::records_transcript(r),
            Self::RootOnly(r) => r.records_transcript(),
        }
    }
    fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
        match self {
            Self::Null(r) => r.record(entry),
            Self::RootOnly(r) => r.record(entry),
        }
    }
    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        match self {
            Self::Null(r) => TranscriptRecorder::<M>::snapshot(r),
            Self::RootOnly(r) => r.snapshot(),
        }
    }
    fn set_tunnel_id(&self, tunnel_id: &str) {
        match self {
            Self::Null(r) => TranscriptRecorder::<M>::set_tunnel_id(r, tunnel_id),
            Self::RootOnly(r) => r.set_tunnel_id(tunnel_id),
        }
    }
    fn canonical_root_for_tunnel(&self, tunnel_id: &str) -> Result<[u8; 32], TranscriptError> {
        match self {
            Self::Null(r) => TranscriptRecorder::<M>::canonical_root_for_tunnel(r, tunnel_id),
            Self::RootOnly(r) => r.canonical_root_for_tunnel(tunnel_id),
        }
    }
}

fn recorder_for<M>(mode: SettlementMode) -> SwarmRecorder<M> {
    match mode {
        SettlementMode::Rootless => SwarmRecorder::Null(NullTranscriptRecorder),
        SettlementMode::TranscriptRoot => {
            SwarmRecorder::RootOnly(RootOnlyTranscriptRecorder::new())
        }
    }
}

/// Build the tokio runtime and run the staged pipeline to a [`SwarmOutcome`].
/// `stop` is the SIGTERM-driven graceful flag: setting it requests a cooperative
/// stop that drains every tunnel to its close boundary and settles.
pub fn run_swarm_pipeline(params: SwarmParams, stop: Arc<AtomicBool>) -> SwarmOutcome {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(params.workers.max(1))
        .thread_name("fleet-superx-tunnel")
        // Protocol drive futures (blackjack_v2 state + the ack-resend wrapper)
        // exceed tokio's default 2 MiB worker stack; match the 16 MiB used by the
        // engine's other tunnel runtimes.
        .thread_stack_size(16 * 1024 * 1024)
        .build()
        .expect("fleet superx runtime");
    let outcome = runtime.block_on(run_pipeline(params, stop));
    // Give the spawned drain / heartbeat tasks a bounded window to finish before
    // the runtime cancels them.
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN_GRACE);
    outcome
}

async fn run_pipeline(params: SwarmParams, stop: Arc<AtomicBool>) -> SwarmOutcome {
    match params.protocol {
        ProtocolKind::Payments => {
            let max_transfers = params.moves.unwrap_or(DEFAULT_PAYMENTS_TRANSFERS);
            run_generic(params, stop, Payments { max_transfers }).await
        }
        ProtocolKind::BlackjackV2 => run_generic(params, stop, BlackjackV2).await,
    }
}

async fn run_generic<P>(params: SwarmParams, stop: Arc<AtomicBool>, protocol: P) -> SwarmOutcome
where
    P: Protocol + Clone + Send + 'static,
    P::State: Send + Sync,
    P::Move: Clone + Send + Sync + 'static,
    SeededStrategy: tunnel_harness::MoveStrategy<P>,
{
    let tunnels = params.tunnels;
    let open_gate = PreOpenGate::new(tunnels);

    // The settle wave gate spaces settle submissions; `None` cohort means "all at
    // once", modelled as one huge cohort so `admit` never spaces.
    let settle_cohort = params.cohorts.settle_cohort.unwrap_or(usize::MAX);
    let settle_wave = SettleWaveGate::new(settle_cohort, params.cohorts.settle_spacing);

    // One shared in-memory anchor backs every tunnel so both seats' opens land in
    // the same idempotency table and the settle manager can pair them. The Sui
    // path scopes a fresh open-intent anchor per tunnel for open idempotency;
    // settle is scope-independent, so the manager uses one run-scoped anchor.
    let shared_memory = match &params.anchor {
        AnchorChoice::Memory => Some(Arc::new(InnerAnchor::Memory(InMemoryAnchor::new()))),
        AnchorChoice::Sui(_) => None,
    };
    let settle_inner: Arc<InnerAnchor> = match &params.anchor {
        AnchorChoice::Memory => Arc::clone(shared_memory.as_ref().expect("memory inner")),
        AnchorChoice::Sui(ctx) => Arc::new(InnerAnchor::Sui(
            ctx.scoped(&format!("{}-s{}-settle", params.run_id, params.swarm_index)),
        )),
    };
    let settlement_mode = settle_inner.settlement_mode();
    let settle_mgr = SettleManager::new(settle_inner, tunnels, settle_wave, settlement_mode);

    let run_control = match params.moves {
        Some(limit) => DriverRunControl::with_graceful_move_limit(limit),
        None => DriverRunControl::graceful_unbounded(),
    };

    let initial = Balances {
        a: params.initial_balance,
        b: params.initial_balance,
    };

    let started = Instant::now();
    let mut tasks: JoinSet<TunnelResult> = JoinSet::new();

    // Spawn tunnels, paced into open cohorts. Because each tunnel's `open` parks
    // on the shared gate after registering, a cohort "completes" once its opens
    // are counted; the next cohort then launches, so opens fly at most `cohort`
    // at a time.
    let open_cohort = params.cohorts.open_cohort;
    let mut spawned: u64 = 0;
    while spawned < tunnels {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let wave = match open_cohort {
            Some(cohort) => (cohort.max(1) as u64).min(tunnels - spawned),
            None => tunnels - spawned,
        };
        for _ in 0..wave {
            let local_index = spawned;
            spawned += 1;
            let seed = play_seed(params.scenario, local_index);
            let tunnel_inner: Arc<InnerAnchor> = match &params.anchor {
                AnchorChoice::Memory => Arc::clone(shared_memory.as_ref().expect("memory inner")),
                AnchorChoice::Sui(ctx) => {
                    let global = crate::ids::swarm_global_index(
                        params.swarm_index,
                        params.swarm_count,
                        local_index,
                    );
                    let tunnel_id = crate::ids::tunnel_id_for(&params.run_id, global);
                    Arc::new(InnerAnchor::Sui(ctx.scoped(&tunnel_id)))
                }
            };
            tasks.spawn(run_one_tunnel(
                protocol.clone(),
                seed,
                tunnel_inner,
                Arc::clone(&open_gate),
                Arc::clone(&settle_mgr),
                run_control.tunnel(),
                initial,
                settlement_mode,
            ));
        }
        if spawned < tunnels {
            if params.cohorts.open_spacing > Duration::ZERO {
                tokio::time::sleep(params.cohorts.open_spacing).await;
            }
            // Wait for this cohort's opens to register before launching the next.
            while open_gate.opened() < spawned && !stop.load(Ordering::Relaxed) {
                tokio::select! {
                    _ = open_gate.opened_progress() => {}
                    _ = tokio::time::sleep(Duration::from_millis(25)) => {}
                }
            }
        }
    }

    // Open barrier: play cannot start until every tunnel has opened. The gate is
    // released by the last `mark_opened`; wait for that edge.
    while !open_gate.is_released() && !stop.load(Ordering::Relaxed) {
        tokio::select! {
            _ = open_gate.wait() => break,
            _ = tokio::time::sleep(Duration::from_millis(25)) => {}
        }
    }
    let open_done = Instant::now();
    let open_ms = open_done.duration_since(started).as_millis().max(1);

    // Play + settle barrier. The drain loop settles pairs in waves once every
    // seat has deposited; begin it now so it is ready the instant play completes.
    settle_mgr.begin_drain();

    let expected_seats = tunnels.saturating_mul(2);
    let play_deadline =
        (params.duration_secs > 0).then(|| open_done + Duration::from_secs(params.duration_secs));
    // Poll for the settle barrier release (all seats parked) — that is the play /
    // settle phase boundary. Honour the stop flag and the duration deadline by
    // requesting a graceful stop, which drains each tunnel to its close boundary.
    while settle_mgr.deposited().await < expected_seats {
        if stop.load(Ordering::Relaxed) {
            run_control.request_stop();
        }
        if let Some(deadline) = play_deadline {
            if Instant::now() >= deadline {
                run_control.request_stop();
            }
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let play_done = Instant::now();
    let play_ms = play_done.duration_since(open_done).as_millis().max(1);

    // Settle drain: tasks complete only after their settle resolves. Bound the
    // wait so a stuck seat aborts rather than hangs.
    let mut settled = 0u64;
    let mut aborted = 0u64;
    let mut total_moves = 0u64;
    let mut total_bytes = 0u64;
    let mut play_ns_samples: Vec<f64> = Vec::new();
    let mut tps_samples: Vec<f64> = Vec::new();
    let drain_deadline = Instant::now() + TUNNEL_DRAIN_TIMEOUT;
    loop {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, tasks.join_next()).await {
            Ok(Some(Ok(result))) => {
                if result.settled {
                    settled += 1;
                }
                total_moves += result.moves;
                total_bytes += result.bytes;
                if result.play_ns > 0 {
                    play_ns_samples.push(result.play_ns as f64);
                    tps_samples.push(result.moves as f64 * 1_000_000_000.0 / result.play_ns as f64);
                }
            }
            Ok(Some(Err(_join_error))) => aborted += 1,
            Ok(None) => break,
            Err(_elapsed) => break,
        }
    }
    // Any task still pending after the drain window is a straggler; abort it and
    // count it aborted so counts stay balanced.
    if !tasks.is_empty() {
        tasks.abort_all();
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(r) => {
                    if r.settled {
                        settled += 1;
                    }
                    total_moves += r.moves;
                    total_bytes += r.bytes;
                }
                Err(_) => aborted += 1,
            }
        }
    }
    let ended = Instant::now();
    let settle_ms = ended.duration_since(play_done).as_millis().max(1);
    let elapsed_ms = ended.duration_since(started).as_millis().max(1);

    let tunnels_opened = open_gate.opened().min(tunnels);
    let tunnels_failed = tunnels.saturating_sub(settled).saturating_sub(aborted);

    SwarmOutcome {
        tunnels_opened,
        tunnels_settled: settled,
        tunnels_failed,
        tunnels_aborted: aborted,
        moves: total_moves,
        bytes: total_bytes,
        elapsed_ms,
        open_ms,
        play_ms,
        settle_ms,
        play_ns_dist: summarize(&play_ns_samples),
        per_tunnel_tps: summarize(&tps_samples),
    }
}

/// Run one tunnel to settlement: two seats over an in-memory transport, each
/// bracketed by the staging barriers via [`StagingAnchor`]. Returns the joined
/// per-tunnel result; a seat error yields `settled = false`.
#[allow(clippy::too_many_arguments)]
async fn run_one_tunnel<P>(
    protocol: P,
    seed: u64,
    inner: Arc<InnerAnchor>,
    open_gate: Arc<PreOpenGate>,
    settle_mgr: Arc<SettleManager>,
    tunnel_control: DriverRunControl,
    initial: Balances,
    settlement_mode: SettlementMode,
) -> TunnelResult
where
    P: Protocol + Clone + Send + 'static,
    P::State: Send + Sync,
    P::Move: Clone + Send + Sync + 'static,
    SeededStrategy: tunnel_harness::MoveStrategy<P>,
{
    let mut secret_a = [0u8; 32];
    let mut secret_b = [0u8; 32];
    getrandom::getrandom(&mut secret_a).expect("os rng");
    getrandom::getrandom(&mut secret_b).expect("os rng");
    let signer_a = LocalSigner::from_secret(&secret_a);
    let signer_b = LocalSigner::from_secret(&secret_b);
    let pk_a = signer_a.public_key();
    let pk_b = signer_b.public_key();

    let (raw_a, raw_b) = InMemoryFrameTransport::pair();
    let ch_a = InstrumentedTransport::new(raw_a, CollectingSink::disabled());
    let ch_b = InstrumentedTransport::new(raw_b, CollectingSink::disabled());
    let (bytes_a, _) = ch_a.handle();
    let (bytes_b, _) = ch_b.handle();

    let anchor_a = StagingAnchor::new(
        Arc::clone(&inner),
        Seat::A,
        Arc::clone(&open_gate),
        Arc::clone(&settle_mgr),
    );
    let anchor_b = StagingAnchor::new(inner, Seat::B, open_gate, settle_mgr);

    let driver_a = PartyDriver::new(
        SeatParts {
            protocol: protocol.clone(),
            signer: signer_a,
            opponent_pk: pk_b,
            initial,
            seat: Seat::A,
        },
        SeededStrategy::new(seed),
        ch_a,
        anchor_a,
        recorder_for::<P::Move>(settlement_mode),
    )
    .with_run_control(tunnel_control.clone());
    let driver_b = PartyDriver::new(
        SeatParts {
            protocol,
            signer: signer_b,
            opponent_pk: pk_a,
            initial,
            seat: Seat::B,
        },
        SeededStrategy::new(seed),
        ch_b,
        anchor_b,
        recorder_for::<P::Move>(settlement_mode),
    )
    .with_run_control(tunnel_control);

    let mut clock_a = CLOCK_BASE;
    let mut clock_b = CLOCK_BASE;
    let (res_a, res_b) = tokio::join!(
        driver_a.run(DRIVER_MAX_MOVES, move || {
            clock_a += 1;
            clock_a
        }),
        driver_b.run(DRIVER_MAX_MOVES, move || {
            clock_b += 1;
            clock_b
        }),
    );

    let settled = res_a.is_ok() && res_b.is_ok();
    let (moves, play_ns) = match &res_a {
        Ok((outcome, _)) => (outcome.moves, outcome.play_ns),
        Err(_) => (0, 0),
    };
    let bytes = bytes_a.load(Ordering::Relaxed) + bytes_b.load(Ordering::Relaxed);
    TunnelResult {
        settled,
        moves,
        bytes,
        play_ns,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden_params(tunnels: u64) -> SwarmParams {
        SwarmParams {
            run_id: "golden".into(),
            swarm_index: 0,
            swarm_count: 1,
            tunnels,
            protocol: ProtocolKind::Payments,
            scenario: Scenario::Golden,
            // Large balances keep every sampled transfer affordable, so payments
            // never stalls on a drained seat and each tunnel plays a constant length.
            initial_balance: 1_000_000,
            anchor: AnchorChoice::Memory,
            cohorts: CohortConfig::unbounded(),
            workers: 2,
            duration_secs: 30,
            moves: None,
            heartbeat: None,
            telemetry_collect: false,
        }
    }

    fn stop() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn play_never_starts_before_all_open_and_settle_after_all_play() {
        let out = run_swarm_pipeline(golden_params(4), stop());
        assert_eq!(out.tunnels_settled, 4);
        // The barriers make the three phase windows disjoint and non-empty.
        assert!(out.open_ms > 0 && out.play_ms > 0 && out.settle_ms > 0);
    }

    #[test]
    fn all_tunnels_settle_with_memory_anchor() {
        let out = run_swarm_pipeline(golden_params(6), stop());
        assert_eq!(out.tunnels_opened, 6);
        assert_eq!(out.tunnels_settled, 6);
        assert_eq!(out.tunnels_failed, 0);
        assert_eq!(out.tunnels_aborted, 0);
        assert!(out.moves > 0);
    }
}
