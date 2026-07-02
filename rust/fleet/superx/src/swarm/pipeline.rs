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

/// Once a barrier abandonment is triggered (stop, deadline, or a failed tunnel),
/// wait this long for still-healthy seats to reach the barrier before forcing it.
/// Lets in-flight tunnels finish and settle cleanly instead of being aborted, yet
/// keeps a degraded swarm bounded.
const BARRIER_GRACE: Duration = Duration::from_millis(250);

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
    /// Test-only: every tunnel's `open` fails, so no seat ever deposits. Exercises
    /// the pipeline's barrier-wait termination on the failure path.
    #[cfg(test)]
    AlwaysFailsOpen,
    /// Test-only: exactly one tunnel's `open` fails while the rest open, play, and
    /// settle. Leaves the settle barrier permanently unfillable (the failed tunnel
    /// never deposits), exercising the partial-failure termination path.
    #[cfg(test)]
    FailsFirstTunnelOpen,
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

/// Running tally of reaped tunnel tasks. Shared by the barrier-wait early reaps
/// (a tunnel that fails before a barrier finishes early) and the final drain, so
/// every task is accounted exactly once regardless of when it terminated.
#[derive(Default)]
struct DrainTally {
    settled: u64,
    /// Tunnels reaped as a clean failure (task returned, but a seat errored so it
    /// never settled). Counted independently of `settled`/`aborted` so the three
    /// tallies sum to the spawned-task count only when every task is accounted —
    /// making that sum a real "no task was silently lost" invariant.
    failed: u64,
    aborted: u64,
    moves: u64,
    bytes: u64,
    play_ns_samples: Vec<f64>,
    tps_samples: Vec<f64>,
}

impl DrainTally {
    /// Fold one joined task. `Ok` carries a tunnel's joined result (settled or a
    /// clean failure); `Err` is a panicked/aborted task counted as aborted.
    fn reap(&mut self, joined: Result<TunnelResult, tokio::task::JoinError>) {
        match joined {
            Ok(result) => {
                if result.settled {
                    self.settled += 1;
                } else {
                    self.failed += 1;
                }
                self.moves += result.moves;
                self.bytes += result.bytes;
                if result.play_ns > 0 {
                    self.play_ns_samples.push(result.play_ns as f64);
                    self.tps_samples
                        .push(result.moves as f64 * 1_000_000_000.0 / result.play_ns as f64);
                }
            }
            Err(_join_error) => self.aborted += 1,
        }
    }
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
        #[cfg(test)]
        AnchorChoice::AlwaysFailsOpen => Some(Arc::new(InnerAnchor::AlwaysFailsOpen)),
        #[cfg(test)]
        AnchorChoice::FailsFirstTunnelOpen => Some(Arc::new(InnerAnchor::FailsFirstTunnelOpen {
            memory: InMemoryAnchor::new(),
            doomed: Arc::new(std::sync::Mutex::new(None)),
        })),
        AnchorChoice::Sui(_) => None,
    };
    let settle_inner: Arc<InnerAnchor> = match &params.anchor {
        AnchorChoice::Memory => Arc::clone(shared_memory.as_ref().expect("memory inner")),
        #[cfg(test)]
        AnchorChoice::AlwaysFailsOpen => Arc::clone(shared_memory.as_ref().expect("shared inner")),
        #[cfg(test)]
        AnchorChoice::FailsFirstTunnelOpen => {
            Arc::clone(shared_memory.as_ref().expect("shared inner"))
        }
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
    // Accounts every task exactly once across the barrier-wait early reaps and the
    // final drain.
    let mut tally = DrainTally::default();

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
                #[cfg(test)]
                AnchorChoice::AlwaysFailsOpen => {
                    Arc::clone(shared_memory.as_ref().expect("shared inner"))
                }
                #[cfg(test)]
                AnchorChoice::FailsFirstTunnelOpen => {
                    Arc::clone(shared_memory.as_ref().expect("shared inner"))
                }
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
            // Bound the wait: if opens in this cohort fail (they never register),
            // stop waiting so the open barrier below can detect the failure and
            // abandon instead of the spawn loop spinning here forever.
            let cohort_deadline = Instant::now() + TUNNEL_DRAIN_TIMEOUT;
            while open_gate.opened() < spawned
                && !stop.load(Ordering::Relaxed)
                && Instant::now() < cohort_deadline
            {
                tokio::select! {
                    _ = open_gate.opened_progress() => {}
                    _ = tokio::time::sleep(Duration::from_millis(25)) => {}
                }
            }
        }
    }

    // Open barrier: play cannot start until every tunnel has opened. Escapes:
    //  - happy: the last `mark_opened` releases the gate;
    //  - failure: a tunnel whose `open` errors finishes early without marking, so
    //    the gate's target is now unreachable — reap finished tasks to detect it;
    //  - stop / hard deadline: an external stop or a stuck open.
    // On any abandonment we force the gate so any healthy seat still parked on
    // `wait` proceeds to play/close, then fall through; the bounded settle drain
    // reaps or aborts whatever remains.
    let open_barrier_deadline = Instant::now() + TUNNEL_DRAIN_TIMEOUT;
    while !open_gate.is_released() {
        // In a healthy open phase no task finishes (all park on the gate), so a
        // finished task here is a failed open.
        let mut failed_open = false;
        while let Some(joined) = tasks.try_join_next() {
            failed_open = true;
            tally.reap(joined);
        }
        if failed_open
            || tasks.is_empty()
            || stop.load(Ordering::Relaxed)
            || Instant::now() >= open_barrier_deadline
        {
            open_gate.force_release();
            break;
        }
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
    // Absolute cap on the play/settle barrier wait, mirroring the open barrier's
    // `open_barrier_deadline`. The barrier only fills once every tunnel deposits
    // both seats; if a tunnel failed (before/during open, or during play) it is
    // permanently unfillable, and with no `duration` deadline and no external stop
    // nothing else would break the loop. This cap — plus the live degraded-open
    // check below — make termination independent of the edge-triggered
    // failed-task signal, so a partial open failure still terminates.
    let play_barrier_deadline = open_done
        + if params.duration_secs > 0 {
            Duration::from_secs(params.duration_secs)
        } else {
            TUNNEL_DRAIN_TIMEOUT
        };
    // Wait for the settle barrier (all seats parked) — the play / settle phase
    // boundary. Escapes, so a never-depositing seat degrades rather than hangs:
    //  - happy: every seat deposits (`deposited == expected_seats`);
    //  - unfillable: the open phase ended degraded (`open_gate.opened() < tunnels`,
    //    so fewer than `expected_seats` can ever deposit), a tunnel finished
    //    without depositing, or the absolute cap elapsed;
    //  - stop / deadline: nudge a graceful close.
    // Any trigger latches `abandon_at`; once the grace elapses we force the settle
    // barrier so deposited seats drain (complete pairs settle, lone seats error)
    // instead of parking forever, and fall through to the bounded drain.
    let mut abandon_at: Option<Instant> = None;
    loop {
        if settle_mgr.deposited().await >= expected_seats {
            break;
        }
        // A finished task during the settle wait is a failed tunnel (a healthy one
        // does not finish until after its settle resolves); reap so it is counted.
        while let Some(joined) = tasks.try_join_next() {
            tally.reap(joined);
        }
        if tasks.is_empty() {
            settle_mgr.force_release().await;
            break;
        }
        let now = Instant::now();
        let deadline_hit = play_deadline.is_some_and(|deadline| now >= deadline);
        let stopping = stop.load(Ordering::Relaxed);
        if stopping || deadline_hit {
            run_control.request_stop();
        }
        // `open_gate.opened() < tunnels` means fewer than `tunnels` seat-A opens
        // landed, so the barrier's `expected_seats` target is unreachable — checked
        // live and independent of whether a task happened to finish this iteration,
        // which is the partial-open-failure case the edge-triggered signal misses.
        let unfillable = open_gate.opened() < tunnels;
        if unfillable || stopping || deadline_hit || now >= play_barrier_deadline {
            abandon_at.get_or_insert(now + BARRIER_GRACE);
        }
        // Latched: once scheduled, force the barrier as soon as the grace elapses,
        // regardless of which trigger fired or whether it still holds this iteration.
        if let Some(at) = abandon_at {
            if Instant::now() >= at {
                settle_mgr.force_release().await;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let play_done = Instant::now();
    let play_ms = play_done.duration_since(open_done).as_millis().max(1);

    // Settle drain: tasks complete only after their settle resolves (or errors).
    // Bound the wait so a stuck seat aborts rather than hangs.
    let drain_deadline = Instant::now() + TUNNEL_DRAIN_TIMEOUT;
    loop {
        let remaining = drain_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, tasks.join_next()).await {
            Ok(Some(joined)) => tally.reap(joined),
            Ok(None) => break,
            Err(_elapsed) => break,
        }
    }
    // Any task still pending after the drain window is a straggler (e.g. a seat
    // parked on a partner that never settled); abort it and reap the cancellation
    // as aborted so counts stay balanced.
    if !tasks.is_empty() {
        tasks.abort_all();
        while let Some(joined) = tasks.join_next().await {
            tally.reap(joined);
        }
    }
    let ended = Instant::now();
    let settle_ms = ended.duration_since(play_done).as_millis().max(1);
    let elapsed_ms = ended.duration_since(started).as_millis().max(1);

    let tunnels_opened = open_gate.opened().min(tunnels);

    SwarmOutcome {
        tunnels_opened,
        tunnels_settled: tally.settled,
        // Independently counted (not derived from settled/aborted) so a lost task
        // shows up as `settled + failed + aborted < tunnels` instead of being
        // silently absorbed into the failed count.
        tunnels_failed: tally.failed,
        tunnels_aborted: tally.aborted,
        moves: tally.moves,
        bytes: tally.bytes,
        elapsed_ms,
        open_ms,
        play_ms,
        settle_ms,
        play_ns_dist: summarize(&tally.play_ns_samples),
        per_tunnel_tps: summarize(&tally.tps_samples),
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

    /// Run the (blocking) pipeline on a watchdog thread so a liveness regression
    /// fails the test with a clear message instead of hanging the whole suite.
    fn run_bounded(params: SwarmParams) -> SwarmOutcome {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(run_swarm_pipeline(params, stop()));
        });
        rx.recv_timeout(Duration::from_secs(30))
            .expect("pipeline must terminate within 30s, not hang")
    }

    #[test]
    fn all_four_tunnels_open_play_and_settle() {
        let out = run_bounded(golden_params(4));
        // Load-bearing: every tunnel opened, then played, then settled. A broken
        // open barrier that let play/settle race ahead of a slow open would leave
        // `tunnels_opened < 4` or a tunnel unsettled; a broken settle barrier would
        // drop the settle count. (`*_ms` are floored with `.max(1)`, so asserting
        // they are positive would be tautological and prove nothing.)
        assert_eq!(out.tunnels_opened, 4);
        assert_eq!(out.tunnels_settled, 4);
        assert_eq!(out.tunnels_failed, 0);
        assert_eq!(out.tunnels_aborted, 0);
    }

    #[test]
    fn all_tunnels_settle_with_memory_anchor() {
        let out = run_bounded(golden_params(6));
        assert_eq!(out.tunnels_opened, 6);
        assert_eq!(out.tunnels_settled, 6);
        assert_eq!(out.tunnels_failed, 0);
        assert_eq!(out.tunnels_aborted, 0);
        assert!(out.moves > 0);
    }

    /// Regression: a swarm whose tunnels *all* fail to open must terminate via the
    /// barrier-wait escapes and the bounded drain, not hang, with every task
    /// accounted rather than lost.
    #[test]
    fn pipeline_terminates_when_tunnels_never_open() {
        let mut params = golden_params(4);
        params.anchor = AnchorChoice::AlwaysFailsOpen;
        // `duration_secs = 0` disables the deadline nudge, so termination here
        // relies solely on failure detection (finished tasks) + forced barriers.
        params.duration_secs = 0;

        let out = run_bounded(params);

        assert_eq!(out.tunnels_opened, 0, "no tunnel opens");
        assert_eq!(out.tunnels_settled, 0, "nothing settles");
        // Independently-counted tallies: this sum equals `tunnels` only if every
        // spawned task was reaped exactly once, so it fails loudly if a task were
        // silently lost rather than being masked by a derived failed count.
        assert_eq!(
            out.tunnels_settled + out.tunnels_failed + out.tunnels_aborted,
            4,
            "every task accounted: settled={} failed={} aborted={}",
            out.tunnels_settled,
            out.tunnels_failed,
            out.tunnels_aborted,
        );
    }

    /// Regression (the liveness bug this pipeline must not have): a *partial* open
    /// failure — one tunnel fails while the rest open, play, and settle — leaves
    /// the settle barrier (`2 * tunnels` seats) permanently unfillable. With
    /// `duration_secs = 0` and no stop there is no deadline or external nudge and
    /// the failed tunnel is reaped at the *open* barrier (never during the settle
    /// wait), so termination cannot rely on the edge-triggered failed-task signal —
    /// only on detecting the unfillable barrier. Must terminate, fully accounted.
    #[test]
    fn pipeline_terminates_on_partial_open_failure() {
        let mut params = golden_params(4);
        params.anchor = AnchorChoice::FailsFirstTunnelOpen;
        params.duration_secs = 0;

        let out = run_bounded(params);

        // Exactly one tunnel is doomed at open; the other three are unaffected.
        assert_eq!(out.tunnels_opened, 3, "one tunnel never opens");
        assert!(
            out.tunnels_failed >= 1,
            "the doomed tunnel is counted as failed, got failed={}",
            out.tunnels_failed,
        );
        // Independently-counted tallies sum to `tunnels` iff no task was lost.
        assert_eq!(
            out.tunnels_settled + out.tunnels_failed + out.tunnels_aborted,
            4,
            "every task accounted: settled={} failed={} aborted={}",
            out.tunnels_settled,
            out.tunnels_failed,
            out.tunnels_aborted,
        );
    }
}
