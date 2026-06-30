//! Drives one party asynchronously, bracketed by chain IO: `open` resolves the
//! tunnel and yields the `tunnel_id` the seat is built from; the move loop runs;
//! `settle` submits the co-signed close. A `TranscriptRecorder` taps each
//! committed transition in the loop's effects band, independent of the anchor.

use crate::{
    Balances, DriverObserver, DriverStart, FrameCodec, FrameTransport, FrameTransportError,
    HarnessError, JsonFrameCodec, MoveCommitted, MoveStrategy, MoveStrategyContext, PartyRuntime,
    Protocol, Seat, SettlementMode, Signer, TranscriptRecorder, TranscriptSettleEntry,
    TunnelAnchor, TunnelAnchorError, TunnelContext, TunnelOpenRequest, TunnelSettleRequest,
};
use std::time::Instant;
use tunnel_core::protocol_id::ProtocolId;
use tunnel_core::wire::{serialize_settlement, serialize_settlement_with_root, Settlement};

#[derive(Debug)]
pub struct DriverOutcome {
    pub moves: u64,
    pub final_balances: Balances,
    /// Wall time spent in the move loop alone, in nanoseconds — excludes anchor
    /// `open`/`settle` and settlement-root construction. Lets callers separate
    /// gameplay latency from chain/setup overhead instead of conflating them
    /// into one end-to-end span.
    pub play_ns: u128,
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

pub struct PartyDriver<P, Pol, Ch, S, A, R, C = JsonFrameCodec>
where
    P: Protocol,
    Pol: MoveStrategy<P>,
    Ch: FrameTransport,
    S: Signer,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
    C: FrameCodec<P::Move>,
{
    parts: SeatParts<P, S>,
    move_strategy: Pol,
    frame_transport: Ch,
    anchor: A,
    recorder: R,
    observers: Vec<Box<dyn DriverObserver>>,
    codec: C,
}

impl<P, Pol, Ch, S, A, R> PartyDriver<P, Pol, Ch, S, A, R, JsonFrameCodec>
where
    P: Protocol,
    Pol: MoveStrategy<P>,
    Ch: FrameTransport,
    S: Signer,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
    JsonFrameCodec: FrameCodec<P::Move>,
{
    pub fn new(
        parts: SeatParts<P, S>,
        move_strategy: Pol,
        frame_transport: Ch,
        anchor: A,
        recorder: R,
    ) -> Self {
        Self::with_codec(
            parts,
            move_strategy,
            frame_transport,
            anchor,
            recorder,
            JsonFrameCodec,
        )
    }
}

impl<P, Pol, Ch, S, A, R, C> PartyDriver<P, Pol, Ch, S, A, R, C>
where
    P: Protocol,
    Pol: MoveStrategy<P>,
    Ch: FrameTransport,
    S: Signer,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
    C: FrameCodec<P::Move>,
{
    pub fn with_codec(
        parts: SeatParts<P, S>,
        move_strategy: Pol,
        frame_transport: Ch,
        anchor: A,
        recorder: R,
        codec: C,
    ) -> Self {
        PartyDriver {
            parts,
            move_strategy,
            frame_transport,
            anchor,
            recorder,
            observers: Vec::new(),
            codec,
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
            codec,
        } = self;

        let result = Self::drive(
            parts,
            codec,
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
        codec: C,
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
        let tunnel_id = opened.tunnel_id.clone();
        let final_nonce = opened.onchain_nonce.checked_add(1).ok_or_else(|| {
            HarnessError::Anchor(TunnelAnchorError::Rejected(
                "opened tunnel nonce cannot be closed".into(),
            ))
        })?;
        let min_timestamp = opened.created_at_ms.unwrap_or(0);
        let mut next_timestamp = || now().max(min_timestamp);

        let our_seat = parts.seat;
        let mut seat = PartyRuntime::<P, S, C>::with_codec(
            parts.protocol,
            parts.signer,
            codec,
            parts.opponent_pk,
            TunnelContext {
                tunnel_id,
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

        // Time the move loop alone — open already resolved above, settle happens
        // after — so callers get gameplay latency free of chain/setup cost.
        let play_started = Instant::now();
        loop {
            if seat.is_terminal() {
                break;
            }
            if moves >= max_moves {
                return Err(HarnessError::Verification(
                    "max moves reached before terminal".into(),
                ));
            }

            if let Some(mv) = move_strategy.plan_move(seat.state(), our_seat, &ctx).await {
                let frame = seat.propose(mv, next_timestamp())?;
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
                            timestamp_ms: next_timestamp(),
                        };
                        for o in observers.iter_mut() {
                            o.on_move_committed(&ev);
                        }
                        if let Some(entry) = seat.take_last_committed() {
                            last_timestamp = entry.timestamp;
                            recorder.record(entry)?;
                        }
                    }
                    None => return Err(HarnessError::FrameTransport(FrameTransportError::Closed)),
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
                        timestamp_ms: next_timestamp(),
                    };
                    for o in observers.iter_mut() {
                        o.on_move_committed(&ev);
                    }
                    if let Some(entry) = seat.take_last_committed() {
                        last_timestamp = entry.timestamp;
                        recorder.record(entry)?;
                    }
                }
                None => return Err(HarnessError::FrameTransport(FrameTransportError::Closed)),
            }
        }

        let play_ns = play_started.elapsed().as_nanos();
        let final_balances = seat.balances();
        // Chain-backed tunnels can reject close timestamps before their on-chain
        // creation time; local anchors have no floor and keep the move-loop clock.
        let timestamp = if moves == 0 {
            next_timestamp()
        } else {
            last_timestamp.max(min_timestamp)
        };
        let settlement = Settlement {
            tunnel_id: seat.tunnel_id().to_string(),
            party_a_balance: final_balances.a,
            party_b_balance: final_balances.b,
            final_nonce,
            timestamp,
        };
        let (signature, transcript_root, transcript_entries) = match anchor.settlement_mode() {
            SettlementMode::Rootless => (
                seat.sign(&serialize_settlement(&settlement)),
                None,
                Vec::new(),
            ),
            SettlementMode::TranscriptRoot => {
                if !recorder.records_transcript() {
                    return Err(HarnessError::Verification(
                        "anchor requires transcript recorder".into(),
                    ));
                }
                let transcript = recorder.snapshot();
                let root = transcript.canonical_root_for_tunnel(seat.tunnel_id())?;
                let msg = serialize_settlement_with_root(&settlement, &root);
                let entries = transcript
                    .entries()
                    .iter()
                    .map(|entry| {
                        TranscriptSettleEntry::from_transcript_entry(seat.tunnel_id(), entry)
                    })
                    .collect();
                (seat.sign(&msg), Some(root), entries)
            }
        };
        anchor
            .settle(TunnelSettleRequest {
                by: our_seat,
                tunnel_id: seat.tunnel_id().to_string(),
                party_a_balance: final_balances.a,
                party_b_balance: final_balances.b,
                final_nonce,
                timestamp,
                signature,
                transcript_root,
                transcript_entries,
            })
            .await?;

        let outcome = DriverOutcome {
            moves,
            final_balances,
            play_ns,
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
        NullTranscriptRecorder, OpenedTunnel, Seat, SettledTunnel, Transcript, TranscriptEntry,
        TranscriptError, TunnelOpenRequest,
    };
    use std::marker::PhantomData;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
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

    #[derive(Clone)]
    struct RejectingRecorder<M>(PhantomData<M>);

    impl<M> Default for RejectingRecorder<M> {
        fn default() -> Self {
            Self(PhantomData)
        }
    }

    impl<M> TranscriptRecorder<M> for RejectingRecorder<M> {
        fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
            Err(TranscriptError::DuplicateNonce { nonce: entry.nonce })
        }

        fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
            Transcript::from_entries(Vec::new())
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

    #[tokio::test]
    async fn max_moves_before_terminal_aborts_without_settling() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let settled = Arc::new(AtomicU64::new(0));
        let driver = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            FailingSendTransport,
            CapturingAnchor::new(
                "0x1",
                0,
                Arc::clone(&settled),
                Arc::new(Mutex::new(Vec::new())),
            ),
            NullTranscriptRecorder,
        );

        let err = driver.run(0, || 1).await.unwrap_err();

        assert!(matches!(err, HarnessError::Verification(_)));
        assert_eq!(settled.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn peer_eof_before_terminal_aborts_without_settling() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let settled = Arc::new(AtomicU64::new(0));
        let driver = PartyDriver::new(
            parts(Seat::B, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            FailingSendTransport,
            CapturingAnchor::new(
                "0x1",
                0,
                Arc::clone(&settled),
                Arc::new(Mutex::new(Vec::new())),
            ),
            NullTranscriptRecorder,
        );

        let err = driver.run(10, || 1).await.unwrap_err();

        assert_eq!(
            err,
            HarnessError::FrameTransport(FrameTransportError::Closed)
        );
        assert_eq!(settled.load(Ordering::Relaxed), 0);
    }

    #[derive(Clone)]
    struct CapturingAnchor {
        tunnel_id: String,
        onchain_nonce: u64,
        created_at_ms: Option<u64>,
        settlement_mode: SettlementMode,
        settled: Arc<AtomicU64>,
        requests: Arc<Mutex<Vec<TunnelSettleRequest>>>,
    }

    impl CapturingAnchor {
        fn new(
            tunnel_id: &str,
            onchain_nonce: u64,
            settled: Arc<AtomicU64>,
            requests: Arc<Mutex<Vec<TunnelSettleRequest>>>,
        ) -> Self {
            Self {
                tunnel_id: tunnel_id.into(),
                onchain_nonce,
                created_at_ms: None,
                settlement_mode: SettlementMode::Rootless,
                settled,
                requests,
            }
        }

        fn with_created_at_ms(mut self, created_at_ms: u64) -> Self {
            self.created_at_ms = Some(created_at_ms);
            self
        }

        fn with_settlement_mode(mut self, settlement_mode: SettlementMode) -> Self {
            self.settlement_mode = settlement_mode;
            self
        }
    }

    impl TunnelAnchor for CapturingAnchor {
        fn settlement_mode(&self) -> SettlementMode {
            self.settlement_mode
        }

        async fn open(
            &self,
            _request: TunnelOpenRequest,
        ) -> Result<OpenedTunnel, TunnelAnchorError> {
            Ok(OpenedTunnel {
                tunnel_id: self.tunnel_id.clone(),
                created: true,
                onchain_nonce: self.onchain_nonce,
                created_at_ms: self.created_at_ms,
            })
        }

        async fn settle(
            &self,
            request: TunnelSettleRequest,
        ) -> Result<SettledTunnel, TunnelAnchorError> {
            self.settled.fetch_add(1, Ordering::Relaxed);
            self.requests.lock().unwrap().push(request);
            Ok(SettledTunnel {
                digest: "0xdigest".into(),
                final_balances: Balances { a: 100, b: 100 },
            })
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settlement_uses_opened_tunnel_onchain_nonce() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 41, Arc::clone(&settled), Arc::clone(&requests));

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor,
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1));
        out_a.unwrap();
        out_b.unwrap();

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.final_nonce == 42));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settlement_timestamp_respects_opened_tunnel_creation_time() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests))
            .with_created_at_ms(10_000);

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor,
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1));
        out_a.unwrap();
        out_b.unwrap();

        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.timestamp >= 10_000));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transcript_root_anchor_requires_recording_recorder() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests))
            .with_settlement_mode(SettlementMode::TranscriptRoot);

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor,
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1));
        assert_eq!(
            out_a.unwrap_err(),
            HarnessError::Verification("anchor requires transcript recorder".into())
        );
        assert_eq!(
            out_b.unwrap_err(),
            HarnessError::Verification("anchor requires transcript recorder".into())
        );
        assert_eq!(settled.load(Ordering::Relaxed), 0);
        assert!(requests.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recorder_failure_aborts_before_settlement() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let settled = Arc::new(AtomicU64::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let anchor = CapturingAnchor::new("0x1", 0, Arc::clone(&settled), Arc::clone(&requests));

        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_a,
            anchor.clone(),
            RejectingRecorder::<OneMove>::default(),
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
                Arc::new(AtomicU64::new(0)),
            ),
            ch_b,
            anchor,
            RejectingRecorder::<OneMove>::default(),
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1));
        let err_a = match out_a {
            Err(e) => e,
            Ok(_) => panic!("seat A should fail on transcript record"),
        };
        let err_b = match out_b {
            Err(e) => e,
            Ok(_) => panic!("seat B should fail on transcript record"),
        };
        assert_eq!(
            err_a,
            HarnessError::Verification("transcript has duplicate entries for nonce 1".into())
        );
        assert_eq!(
            err_b,
            HarnessError::Verification("transcript has duplicate entries for nonce 1".into())
        );
        assert_eq!(settled.load(Ordering::Relaxed), 0);
        assert!(requests.lock().unwrap().is_empty());
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
