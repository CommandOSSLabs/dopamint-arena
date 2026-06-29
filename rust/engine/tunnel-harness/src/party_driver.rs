//! Drives one party asynchronously, bracketed by chain IO: `open` resolves the
//! tunnel and yields the `tunnel_id` the seat is built from; the move loop runs;
//! `settle` submits the co-signed v1 close. A `TranscriptRecorder` taps each
//! committed transition in the loop's effects band, independent of the anchor.

use crate::{
    Balances, DriverObserver, DriverStart, FrameTransport, HarnessError, MoveCommitted,
    MoveStrategy, MoveStrategyContext, PartyRuntime, Protocol, Seat, Signer, TranscriptRecorder,
    TunnelAnchor, TunnelAnchorError, TunnelContext, TunnelOpenRequest, TunnelSettleRequest,
};
use tunnel_core::protocol_id::ProtocolId;
use tunnel_core::wire::{serialize_settlement, Settlement};

#[derive(Debug)]
pub struct DriverOutcome {
    pub moves: u64,
    pub final_balances: Balances,
}

/// Everything needed to build the seat except the `tunnel_id`, which `open`
/// produces. Held by the driver so the seat is constructed post-open.
pub struct SeatParts<P: Protocol, S: Signer> {
    pub protocol: P,
    pub signer: S,
    pub opponent_pk: [u8; 32],
    pub initial: Balances,
    pub seat: Seat,
}

pub struct PartyDriver<P, Pol, Ch, S, A, R>
where
    P: Protocol,
    Pol: MoveStrategy<P>,
    Ch: FrameTransport,
    S: Signer,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
{
    parts: SeatParts<P, S>,
    move_strategy: Pol,
    frame_transport: Ch,
    anchor: A,
    recorder: R,
    observers: Vec<Box<dyn DriverObserver>>,
}

impl<P, Pol, Ch, S, A, R> PartyDriver<P, Pol, Ch, S, A, R>
where
    P: Protocol,
    Pol: MoveStrategy<P>,
    Ch: FrameTransport,
    S: Signer,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
{
    pub fn new(
        parts: SeatParts<P, S>,
        move_strategy: Pol,
        frame_transport: Ch,
        anchor: A,
        recorder: R,
    ) -> Self {
        PartyDriver {
            parts,
            move_strategy,
            frame_transport,
            anchor,
            recorder,
            observers: Vec::new(),
        }
    }

    /// Register a passive lifecycle observer. Observers are notified in
    /// registration order; each receives every event read-only.
    pub fn observe(mut self, observer: Box<dyn DriverObserver>) -> Self {
        self.observers.push(observer);
        self
    }

    /// Open, drive to terminal while recording each commit, then settle. Returns
    /// the outcome and the recorder so the caller can export afterwards.
    pub async fn run(
        self,
        max_moves: u64,
        mut now: impl FnMut() -> u64 + Send,
    ) -> Result<(DriverOutcome, R), HarnessError> {
        let PartyDriver {
            parts,
            mut move_strategy,
            frame_transport,
            anchor,
            recorder,
            mut observers,
        } = self;

        let result = Self::drive(
            parts,
            &mut move_strategy,
            &frame_transport,
            &anchor,
            &recorder,
            &mut observers,
            max_moves,
            &mut now,
        )
        .await;

        match result {
            Ok(outcome) => Ok((outcome, recorder)),
            Err(e) => {
                move_strategy.abort();
                for o in &mut observers {
                    o.on_aborted();
                }
                Err(e)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn drive(
        parts: SeatParts<P, S>,
        move_strategy: &mut Pol,
        frame_transport: &Ch,
        anchor: &A,
        recorder: &R,
        observers: &mut [Box<dyn DriverObserver>],
        max_moves: u64,
        now: &mut (impl FnMut() -> u64 + Send),
    ) -> Result<DriverOutcome, HarnessError> {
        let protocol_id = ProtocolId::parse(parts.protocol.name())
            .map_err(|e| HarnessError::Anchor(TunnelAnchorError::Rejected(e.to_string())))?;
        let my_pk = parts.signer.public_key();
        let (party_a, party_b) = match parts.seat {
            Seat::A => (my_pk, parts.opponent_pk),
            Seat::B => (parts.opponent_pk, my_pk),
        };
        let opened = anchor
            .open(TunnelOpenRequest {
                protocol: protocol_id,
                party_a,
                party_b,
                initial: parts.initial,
            })
            .await?;

        let our_seat = parts.seat;
        let mut seat = PartyRuntime::<P, S>::new(
            parts.protocol,
            parts.signer,
            parts.opponent_pk,
            TunnelContext {
                tunnel_id: opened.tunnel_id,
                initial: parts.initial,
                seat: our_seat,
            },
        );

        let ctx = MoveStrategyContext {
            tunnel_id: String::new(),
            seat: our_seat,
        };
        let start = DriverStart {
            tunnel_id: seat.tunnel_id(),
            our_seat,
        };
        for o in observers.iter_mut() {
            o.on_started(&start);
        }

        let mut moves = 0u64;
        let mut last_timestamp = 0u64;

        loop {
            if seat.is_terminal() || moves >= max_moves {
                break;
            }

            if let Some(mv) = move_strategy.plan_move(seat.state(), our_seat, &ctx).await {
                let frame = seat.propose(mv, now())?;
                frame_transport.send(frame).await?;
                match frame_transport.recv().await? {
                    Some(bytes) => {
                        let out = seat.handle_frame(&bytes)?;
                        move_strategy.confirm_move(seat.state());
                        for f in out {
                            frame_transport.send(f).await?;
                        }
                        moves += 1;
                        let ev = MoveCommitted {
                            by: our_seat,
                            nonce: seat.nonce(),
                            move_index: moves,
                            timestamp_ms: now(),
                        };
                        for o in observers.iter_mut() {
                            o.on_move_committed(&ev);
                        }
                        if let Some(entry) = seat.take_last_committed() {
                            last_timestamp = entry.timestamp;
                            recorder.record(entry);
                        }
                    }
                    None => break,
                }
                continue;
            }

            match frame_transport.recv().await? {
                Some(bytes) => {
                    let out = seat.handle_frame(&bytes)?;
                    for f in out {
                        frame_transport.send(f).await?;
                    }
                    moves += 1;
                    let ev = MoveCommitted {
                        by: our_seat.other(),
                        nonce: seat.nonce(),
                        move_index: moves,
                        timestamp_ms: now(),
                    };
                    for o in observers.iter_mut() {
                        o.on_move_committed(&ev);
                    }
                    if let Some(entry) = seat.take_last_committed() {
                        last_timestamp = entry.timestamp;
                        recorder.record(entry);
                    }
                }
                None => break,
            }
        }

        let final_balances = seat.balances();
        let final_nonce = seat.nonce();
        let timestamp = if moves == 0 { now() } else { last_timestamp };
        // NOTE: Move recomputes `final_nonce = state.nonce + 1` at
        // `close_cooperative` (ADR-0007). For the in-memory anchor both seats sign
        // identical bytes regardless of the exact value; pin this against the real
        // contract when a chain anchor lands.
        let settlement = Settlement {
            tunnel_id: seat.tunnel_id().to_string(),
            party_a_balance: final_balances.a,
            party_b_balance: final_balances.b,
            final_nonce,
            timestamp,
        };
        let signature = seat.sign(&serialize_settlement(&settlement));
        anchor
            .settle(TunnelSettleRequest {
                by: our_seat,
                tunnel_id: seat.tunnel_id().to_string(),
                party_a_balance: final_balances.a,
                party_b_balance: final_balances.b,
                final_nonce,
                timestamp,
                signature,
            })
            .await?;

        let outcome = DriverOutcome {
            moves,
            final_balances,
        };
        for o in observers.iter_mut() {
            o.on_finished(&outcome);
        }
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Balances, FrameTransportError, InMemoryAnchor, InMemoryFrameTransport, LocalSigner,
        NullTranscriptRecorder, Seat,
    };
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    use tunnel_core::crypto::keypair_from_secret;

    #[derive(Clone)]
    struct OneMoveProtocol;

    #[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
    struct OneMove;

    #[derive(Clone)]
    struct OneMoveState {
        moved: bool,
        balances: Balances,
    }

    impl Protocol for OneMoveProtocol {
        type State = OneMoveState;
        type Move = OneMove;

        fn name(&self) -> &str {
            "one_move.v1"
        }

        fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
            OneMoveState {
                moved: false,
                balances: ctx.initial,
            }
        }

        fn apply_move(
            &self,
            state: &Self::State,
            _mv: &Self::Move,
            by: Seat,
        ) -> Result<Self::State, crate::ProtocolError> {
            if by != Seat::A {
                return Err(crate::ProtocolError("only A can move".into()));
            }
            if state.moved {
                return Err(crate::ProtocolError("already moved".into()));
            }
            Ok(OneMoveState {
                moved: true,
                balances: state.balances,
            })
        }

        fn encode_state(&self, state: &Self::State) -> Vec<u8> {
            vec![u8::from(state.moved)]
        }

        fn balances(&self, state: &Self::State) -> Balances {
            state.balances
        }

        fn is_terminal(&self, state: &Self::State) -> bool {
            state.moved
        }
    }

    struct TrackingStrategy {
        seat: Seat,
        planned: Arc<AtomicU64>,
        confirmed: Arc<AtomicU64>,
        aborted: Arc<AtomicU64>,
    }

    impl TrackingStrategy {
        fn new(
            seat: Seat,
            planned: Arc<AtomicU64>,
            confirmed: Arc<AtomicU64>,
            aborted: Arc<AtomicU64>,
        ) -> Self {
            Self {
                seat,
                planned,
                confirmed,
                aborted,
            }
        }
    }

    impl MoveStrategy<OneMoveProtocol> for TrackingStrategy {
        async fn plan_move(
            &mut self,
            state: &OneMoveState,
            seat: Seat,
            _ctx: &crate::MoveStrategyContext,
        ) -> Option<OneMove> {
            if self.seat == Seat::A && seat == Seat::A && !state.moved {
                self.planned.fetch_add(1, Ordering::Relaxed);
                return Some(OneMove);
            }
            None
        }

        fn confirm_move(&mut self, state: &OneMoveState) {
            if state.moved {
                self.confirmed.fetch_add(1, Ordering::Relaxed);
            }
        }

        fn abort(&mut self) {
            self.aborted.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn parts(
        seat: Seat,
        secret: &[u8; 32],
        opponent_pk: [u8; 32],
    ) -> SeatParts<OneMoveProtocol, LocalSigner> {
        SeatParts {
            protocol: OneMoveProtocol,
            signer: LocalSigner::from_secret(secret),
            opponent_pk,
            initial: Balances { a: 100, b: 100 },
            seat,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn strategy_confirms_after_own_move_is_acked() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let planned = Arc::new(AtomicU64::new(0));
        let confirmed = Arc::new(AtomicU64::new(0));
        let aborted = Arc::new(AtomicU64::new(0));

        let anchor = InMemoryAnchor::with_fixed_id("0x1");
        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::clone(&planned),
                Arc::clone(&confirmed),
                Arc::clone(&aborted),
            ),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::clone(&planned),
                Arc::clone(&confirmed),
                Arc::clone(&aborted),
            ),
            ch_b,
            anchor.clone(),
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1),);

        assert!(out_a.unwrap().0.final_balances.sum() == 200);
        assert!(out_b.unwrap().0.final_balances.sum() == 200);
        assert_eq!(planned.load(Ordering::Relaxed), 1);
        assert_eq!(confirmed.load(Ordering::Relaxed), 1);
        assert_eq!(aborted.load(Ordering::Relaxed), 0);
    }

    struct FailingSendTransport;

    impl FrameTransport for FailingSendTransport {
        async fn send(&self, _bytes: Vec<u8>) -> Result<(), FrameTransportError> {
            Err(FrameTransportError::Transport("send failed".into()))
        }

        async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
            Ok(None)
        }
    }

    #[tokio::test]
    async fn strategy_aborts_when_driver_errors() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let planned = Arc::new(AtomicU64::new(0));
        let confirmed = Arc::new(AtomicU64::new(0));
        let aborted = Arc::new(AtomicU64::new(0));
        let driver = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::clone(&planned),
                Arc::clone(&confirmed),
                Arc::clone(&aborted),
            ),
            FailingSendTransport,
            InMemoryAnchor::with_fixed_id("0x1"),
            NullTranscriptRecorder,
        );

        let err = driver.run(10, || 1).await.unwrap_err();

        assert_eq!(
            err,
            HarnessError::FrameTransport(FrameTransportError::Transport("send failed".into()))
        );
        assert_eq!(planned.load(Ordering::Relaxed), 1);
        assert_eq!(confirmed.load(Ordering::Relaxed), 0);
        assert_eq!(aborted.load(Ordering::Relaxed), 1);
    }

    use crate::{DriverObserver, DriverStart, MoveCommitted};

    #[derive(Default)]
    struct CountingObserver {
        started: Vec<(String, Seat)>,
        moves: Vec<MoveCommitted>,
        finished: u64,
        aborted: u64,
    }

    impl DriverObserver for CountingObserver {
        fn on_started(&mut self, s: &DriverStart<'_>) {
            self.started.push((s.tunnel_id.to_string(), s.our_seat));
        }

        fn on_move_committed(&mut self, ev: &MoveCommitted) {
            self.moves.push(*ev);
        }

        fn on_finished(&mut self, _o: &DriverOutcome) {
            self.finished += 1;
        }

        fn on_aborted(&mut self) {
            self.aborted += 1;
        }
    }

    // A shared recorder so the test can read what the driver fanned out.
    #[derive(Clone, Default)]
    struct SharedObserver(Arc<std::sync::Mutex<CountingObserver>>);

    impl DriverObserver for SharedObserver {
        fn on_started(&mut self, s: &DriverStart<'_>) {
            self.0.lock().unwrap().on_started(s);
        }

        fn on_move_committed(&mut self, ev: &MoveCommitted) {
            self.0.lock().unwrap().on_move_committed(ev);
        }

        fn on_finished(&mut self, o: &DriverOutcome) {
            self.0.lock().unwrap().on_finished(o);
        }

        fn on_aborted(&mut self) {
            self.0.lock().unwrap().on_aborted();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn driver_fans_lifecycle_events_to_observers() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let z = || Arc::new(AtomicU64::new(0));

        let obs_a = SharedObserver::default();
        let obs_a2 = SharedObserver::default();
        let anchor = InMemoryAnchor::with_fixed_id("0x1");
        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(Seat::A, z(), z(), z()),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        )
        .observe(Box::new(obs_a.clone()))
        .observe(Box::new(obs_a2.clone()));
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(Seat::B, z(), z(), z()),
            ch_b,
            anchor.clone(),
            NullTranscriptRecorder,
        );

        let mut ta = 0u64;
        let (ra, rb) = tokio::join!(
            driver_a.run(10, move || {
                ta += 100;
                ta
            }),
            driver_b.run(10, || 1),
        );
        ra.unwrap();
        rb.unwrap();

        let a = obs_a.0.lock().unwrap();
        assert_eq!(a.started, vec![("0x1".to_string(), Seat::A)]);
        assert_eq!(a.finished, 1);
        assert_eq!(a.aborted, 0);
        // OneMove protocol: exactly one committed move, authored by Seat::A.
        assert_eq!(a.moves.len(), 1);
        assert_eq!(a.moves[0].by, Seat::A);
        assert_eq!(a.moves[0].move_index, 1);
        assert_eq!(a.moves[0].nonce, 1);
        assert!(a.moves[0].timestamp_ms >= 100);
        // Fan-out: the second observer saw the same single move.
        assert_eq!(obs_a2.0.lock().unwrap().moves.len(), 1);
    }

    #[tokio::test]
    async fn driver_notifies_observers_on_abort() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let z = || Arc::new(AtomicU64::new(0));
        let obs = SharedObserver::default();
        let driver = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(Seat::A, z(), z(), z()),
            FailingSendTransport,
            InMemoryAnchor::with_fixed_id("0x1"),
            NullTranscriptRecorder,
        )
        .observe(Box::new(obs.clone()));

        let res = driver.run(10, || 1).await;
        assert!(res.is_err());
        let g = obs.0.lock().unwrap();
        assert_eq!(g.aborted, 1);
        assert_eq!(g.finished, 0);
    }
}
