//! The synchronous in-process match driver: two `PartyRuntime`s pumped against each
//! other with no frame transport and no async frame loop. Mirrors loadbench's `playMatch`
//! (basic-strategy bots, then an anchored cooperative settlement). `bytes`
//! counts MOVE/ACK frame bytes only — the determinism gate (143*N / 75982*N).

use crate::cli::{AnchorMode, TranscriptRecorderMode};
use std::future::Future;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
use std::time::Instant;
use tunnel_blackjack::v2::{BlackjackV2, BlackjackV2Move, BlackjackV2Strategy};
use tunnel_blackjack::{BjMove, Blackjack, BlackjackStrategy};
use tunnel_core::protocol_id::ProtocolId;
use tunnel_core::wire::{serialize_settlement, Settlement};
use tunnel_harness::{
    Balances, FrameCodec, InMemoryAnchor, InMemoryTranscriptRecorder, LocalSigner, MoveStrategy,
    MoveStrategyContext, PartyRuntime, Protocol, Seat, Signer, TranscriptRecorder, TunnelAnchor,
    TunnelContext, TunnelOpenRequest, TunnelSettleRequest,
};

type Seats<P, C> = PartyRuntime<P, LocalSigner, C>;

pub struct MatchResult {
    pub moves: u64,
    pub bytes: usize,
    pub final_balance_a: u64,
    pub final_balance_b: u64,
    pub play_ns: u128,
    pub transcript_entries: u64,
}

/// Pre-built signer material for both seats.
#[derive(Clone)]
pub struct SeatKit {
    signer_a: LocalSigner,
    signer_b: LocalSigner,
    pk_a: [u8; 32],
    pk_b: [u8; 32],
}

impl SeatKit {
    pub fn new(secret_a: &[u8; 32], secret_b: &[u8; 32]) -> SeatKit {
        let signer_a = LocalSigner::from_secret(secret_a);
        let signer_b = LocalSigner::from_secret(secret_b);
        SeatKit {
            pk_a: signer_a.public_key(),
            pk_b: signer_b.public_key(),
            signer_a,
            signer_b,
        }
    }
}

/// Pump one seat's MOVE to the other and the ACK back until quiescent; returns bytes sent.
fn deliver<P, C>(proposer: &mut Seats<P, C>, responder: &mut Seats<P, C>, first: Vec<u8>) -> usize
where
    P: Protocol,
    C: FrameCodec<P::Move>,
{
    let mut bytes = first.len();
    let mut to_responder = vec![first];
    loop {
        let mut to_proposer = Vec::new();
        for f in &to_responder {
            to_proposer.extend(responder.handle_frame(f).expect("legal frame"));
        }
        if to_proposer.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for f in &to_proposer {
            bytes += f.len();
            next.extend(proposer.handle_frame(f).expect("legal frame"));
        }
        if next.is_empty() {
            break;
        }
        for f in &next {
            bytes += f.len();
        }
        to_responder = next;
    }
    bytes
}

/// Inject the per-match card seed into a seat's blackjack state before play. `None`
/// keeps the golden deterministic stream (byte-identical to the legacy gate).
fn seed_cards<C: FrameCodec<BjMove>>(seat: &mut Seats<Blackjack, C>, card_seed: Option<u64>) {
    if card_seed.is_some() {
        seat.with_state_mut(|s| s.card_seed = card_seed);
    }
}

fn noop_raw_waker() -> RawWaker {
    fn clone(_: *const ()) -> RawWaker {
        noop_raw_waker()
    }
    fn wake(_: *const ()) {}
    fn wake_by_ref(_: *const ()) {}
    fn drop(_: *const ()) {}

    RawWaker::new(
        std::ptr::null(),
        &RawWakerVTable::new(clone, wake, wake_by_ref, drop),
    )
}

fn block_ready<F: Future>(future: F) -> F::Output {
    let waker = unsafe { Waker::from_raw(noop_raw_waker()) };
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(output) => output,
        Poll::Pending => panic!("fleet-bench MoveStrategy futures must complete synchronously"),
    }
}

thread_local! {
    static ANCHOR_RUNTIME: tokio::runtime::Runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("anchor runtime");
}

fn block_anchor<F: Future>(future: F) -> F::Output {
    ANCHOR_RUNTIME.with(|rt| rt.block_on(future))
}

enum BenchTranscriptRecorder<M> {
    None,
    Memory(InMemoryTranscriptRecorder<M>),
}

impl<M: Clone> BenchTranscriptRecorder<M> {
    fn new(mode: TranscriptRecorderMode) -> Self {
        match mode {
            TranscriptRecorderMode::None => Self::None,
            TranscriptRecorderMode::Memory => Self::Memory(InMemoryTranscriptRecorder::new()),
        }
    }

    fn record_from<P, C>(&self, seat: &mut Seats<P, C>)
    where
        P: Protocol<Move = M>,
        C: FrameCodec<M>,
    {
        if let Some(entry) = seat.take_last_committed() {
            match self {
                Self::None => {}
                Self::Memory(recorder) => recorder.record(entry),
            }
        }
    }

    fn len(&self) -> u64 {
        match self {
            Self::None => 0,
            Self::Memory(recorder) => recorder.snapshot().entries().len() as u64,
        }
    }
}

fn open_anchor<P: Protocol>(
    anchor_mode: AnchorMode,
    protocol: &P,
    kit: &SeatKit,
    tunnel_id: &str,
    initial: Balances,
) -> (InMemoryAnchor, String, u64) {
    match anchor_mode {
        AnchorMode::Memory => {
            let anchor = InMemoryAnchor::with_fixed_id(tunnel_id);
            let protocol =
                ProtocolId::parse(protocol.name()).expect("bench protocol id is canonical");
            let opened = block_anchor(anchor.open(TunnelOpenRequest {
                protocol,
                party_a: kit.pk_a,
                party_b: kit.pk_b,
                initial,
            }))
            .expect("memory anchor open");
            (anchor, opened.tunnel_id, opened.onchain_nonce)
        }
    }
}

fn settle_anchor<P, C>(
    anchor_mode: AnchorMode,
    anchor: InMemoryAnchor,
    tunnel_id: &str,
    final_nonce: u64,
    timestamp: u64,
    a: &Seats<P, C>,
    b: &Seats<P, C>,
) where
    P: Protocol,
    C: FrameCodec<P::Move>,
{
    match anchor_mode {
        AnchorMode::Memory => {
            let bals = a.balances();
            let settlement = Settlement {
                tunnel_id: tunnel_id.to_string(),
                party_a_balance: bals.a,
                party_b_balance: bals.b,
                final_nonce,
                timestamp,
            };
            let msg = serialize_settlement(&settlement);
            let half_a = TunnelSettleRequest {
                tunnel_id: tunnel_id.to_string(),
                by: Seat::A,
                party_a_balance: bals.a,
                party_b_balance: bals.b,
                final_nonce,
                timestamp,
                signature: a.sign(&msg),
            };
            let half_b = TunnelSettleRequest {
                tunnel_id: tunnel_id.to_string(),
                by: Seat::B,
                party_a_balance: bals.a,
                party_b_balance: bals.b,
                final_nonce,
                timestamp,
                signature: b.sign(&msg),
            };
            let (settled_a, settled_b) =
                block_anchor(async { tokio::join!(anchor.settle(half_a), anchor.settle(half_b)) });
            let settled_a = settled_a.expect("memory anchor settle A");
            let settled_b = settled_b.expect("memory anchor settle B");
            assert_eq!(settled_a.final_balances, bals);
            assert_eq!(settled_b.final_balances, bals);
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn play_protocol_match_with_strategies<P, C, StrategyA, StrategyB>(
    protocol: P,
    mut strategy_a: StrategyA,
    mut strategy_b: StrategyB,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
    anchor_mode: AnchorMode,
    transcript_recorder: TranscriptRecorderMode,
    configure: impl FnOnce(&mut Seats<P, C>, &mut Seats<P, C>),
) -> MatchResult
where
    P: Protocol + Clone,
    P::Move: Clone,
    C: FrameCodec<P::Move> + Default,
    StrategyA: MoveStrategy<P>,
    StrategyB: MoveStrategy<P>,
{
    let initial = Balances {
        a: balance_a,
        b: balance_b,
    };
    let (anchor, tunnel_id, onchain_nonce) =
        open_anchor(anchor_mode, &protocol, kit, tunnel_id, initial);
    let ctx = |seat| TunnelContext {
        tunnel_id: tunnel_id.clone(),
        initial,
        seat,
    };
    let mut a: Seats<P, C> = PartyRuntime::new(
        protocol.clone(),
        kit.signer_a.clone(),
        kit.pk_b,
        ctx(Seat::A),
    );
    let mut b: Seats<P, C> = PartyRuntime::new(
        protocol.clone(),
        kit.signer_b.clone(),
        kit.pk_a,
        ctx(Seat::B),
    );
    configure(&mut a, &mut b);

    let started = Instant::now();
    let mut moves = 0u64;
    let mut bytes = 0usize;
    let mut ts = created_at;
    let recorder = BenchTranscriptRecorder::new(transcript_recorder);
    let strategy_ctx_a = MoveStrategyContext {
        tunnel_id: tunnel_id.clone(),
        seat: Seat::A,
    };
    let strategy_ctx_b = MoveStrategyContext {
        tunnel_id: tunnel_id.clone(),
        seat: Seat::B,
    };

    'outer: while moves < max_moves && !a.is_terminal() {
        let mut progressed = false;
        for p in [Seat::A, Seat::B] {
            if a.is_terminal() {
                break;
            }
            let mv = match p {
                Seat::A => block_ready(strategy_a.plan_move(a.state(), p, &strategy_ctx_a)),
                Seat::B => block_ready(strategy_b.plan_move(b.state(), p, &strategy_ctx_b)),
            };
            let Some(mv) = mv else { continue };
            ts += 1;
            let first = if p == Seat::A {
                a.propose(mv, ts).expect("legal move")
            } else {
                b.propose(mv, ts).expect("legal move")
            };
            bytes += if p == Seat::A {
                deliver(&mut a, &mut b, first)
            } else {
                deliver(&mut b, &mut a, first)
            };
            recorder.record_from(&mut a);
            recorder.record_from(&mut b);
            match p {
                Seat::A => strategy_a.confirm_move(a.state()),
                Seat::B => strategy_b.confirm_move(b.state()),
            }
            moves += 1;
            progressed = true;
            if moves >= max_moves {
                break 'outer;
            }
        }
        if !progressed {
            break;
        }
    }

    // Anchor settlement is not counted in frame bytes; the metric tracks MOVE/ACK wire only.
    let bals = a.balances();
    settle_anchor(
        anchor_mode,
        anchor,
        &tunnel_id,
        onchain_nonce.checked_add(1).expect("anchor nonce closes"),
        created_at,
        &a,
        &b,
    );

    MatchResult {
        moves,
        bytes,
        final_balance_a: bals.a,
        final_balance_b: bals.b,
        play_ns: started.elapsed().as_nanos(),
        transcript_entries: recorder.len(),
    }
}

#[allow(clippy::too_many_arguments)]
pub fn play_match_seeded<C: FrameCodec<BjMove> + Default>(
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
    anchor_mode: AnchorMode,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    play_protocol_match_with_strategies::<Blackjack, C, BlackjackStrategy, BlackjackStrategy>(
        Blackjack,
        BlackjackStrategy,
        BlackjackStrategy,
        kit,
        tunnel_id,
        balance_a,
        balance_b,
        created_at,
        max_moves,
        anchor_mode,
        transcript_recorder,
        |a, b| {
            seed_cards(a, card_seed);
            seed_cards(b, card_seed);
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn play_blackjack_v2_seeded<C: FrameCodec<BlackjackV2Move> + Default>(
    move_seed: u64,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
    anchor_mode: AnchorMode,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    play_protocol_match_with_strategies::<BlackjackV2, C, BlackjackV2Strategy, BlackjackV2Strategy>(
        BlackjackV2,
        BlackjackV2Strategy::new(move_seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        BlackjackV2Strategy::new(move_seed ^ 0x5A5A_A5A5_CAFE_BABE),
        kit,
        tunnel_id,
        balance_a,
        balance_b,
        created_at,
        max_moves,
        anchor_mode,
        transcript_recorder,
        |_, _| {},
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::{
        BcsFrameCodec, JsonFrameCodec, MoveStrategy, MoveStrategyContext, PostcardFrameCodec,
        ProtocolError,
    };

    const BCS_GOLDEN_BYTES: usize = 29492;
    const POSTCARD_GOLDEN_BYTES: usize = 24985;

    fn golden_match<C: tunnel_harness::FrameCodec<tunnel_blackjack::BjMove> + Default>(
    ) -> MatchResult {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);
        play_match_seeded::<C>(
            None,
            &kit,
            "0x1",
            200,
            200,
            1234567890,
            1000,
            AnchorMode::Memory,
            TranscriptRecorderMode::None,
        )
    }

    #[test]
    fn json_match_is_143_moves_and_75982_bytes() {
        let r = golden_match::<JsonFrameCodec>();
        assert_eq!(r.moves, 143, "golden deterministic move count");
        assert_eq!(r.bytes, 75982, "golden JSON frame bytes");
        assert_eq!(r.final_balance_a + r.final_balance_b, 400);
    }

    #[test]
    fn move_count_is_codec_independent() {
        let j = golden_match::<JsonFrameCodec>();
        let b = golden_match::<BcsFrameCodec>();
        let p = golden_match::<PostcardFrameCodec>();
        for r in [&b, &p] {
            assert_eq!(r.moves, j.moves);
            assert_eq!(r.final_balance_a, j.final_balance_a);
            assert_eq!(r.final_balance_b, j.final_balance_b);
        }
        assert!(
            b.bytes < j.bytes && p.bytes < j.bytes,
            "json={} bcs={} postcard={}",
            j.bytes,
            b.bytes,
            p.bytes
        );
    }

    #[test]
    fn bcs_match_byte_golden() {
        assert_eq!(golden_match::<BcsFrameCodec>().bytes, BCS_GOLDEN_BYTES);
    }

    #[test]
    fn postcard_match_byte_golden() {
        assert_eq!(
            golden_match::<PostcardFrameCodec>().bytes,
            POSTCARD_GOLDEN_BYTES
        );
    }

    #[derive(Clone)]
    struct StrategyOnlyProtocol;

    #[derive(Clone)]
    struct StrategyOnlyState {
        moved: bool,
        balances: Balances,
    }

    impl Protocol for StrategyOnlyProtocol {
        type State = StrategyOnlyState;
        type Move = bool;

        fn name(&self) -> &str {
            "strategy_only.v1"
        }

        fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
            StrategyOnlyState {
                moved: false,
                balances: ctx.initial,
            }
        }

        fn apply_move(
            &self,
            state: &Self::State,
            mv: &Self::Move,
            by: Seat,
        ) -> Result<Self::State, ProtocolError> {
            if by != Seat::A {
                return Err(ProtocolError("only A may move".into()));
            }
            if !mv {
                return Err(ProtocolError("strategy move must be true".into()));
            }
            Ok(StrategyOnlyState {
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

        fn sample_move(
            &self,
            _state: &Self::State,
            _seat: Seat,
            _rng: &mut dyn FnMut() -> f64,
        ) -> Option<Self::Move> {
            panic!("bench driver must use MoveStrategy, not Protocol::sample_move")
        }
    }

    struct StrategyOnlyMoveStrategy;

    impl MoveStrategy<StrategyOnlyProtocol> for StrategyOnlyMoveStrategy {
        async fn plan_move(
            &mut self,
            state: &StrategyOnlyState,
            seat: Seat,
            _ctx: &MoveStrategyContext,
        ) -> Option<bool> {
            (seat == Seat::A && !state.moved).then_some(true)
        }
    }

    #[test]
    fn generic_driver_uses_move_strategy_not_protocol_sampler() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);

        let result = play_protocol_match_with_strategies::<
            StrategyOnlyProtocol,
            JsonFrameCodec,
            StrategyOnlyMoveStrategy,
            StrategyOnlyMoveStrategy,
        >(
            StrategyOnlyProtocol,
            StrategyOnlyMoveStrategy,
            StrategyOnlyMoveStrategy,
            &kit,
            "0xabc123",
            100,
            100,
            1234567890,
            10,
            AnchorMode::Memory,
            TranscriptRecorderMode::None,
            |_, _| {},
        );

        assert_eq!(result.moves, 1);
        assert_eq!(result.final_balance_a + result.final_balance_b, 200);
    }

    #[test]
    fn memory_transcript_recorder_counts_committed_entries() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);

        let result = play_protocol_match_with_strategies::<
            StrategyOnlyProtocol,
            JsonFrameCodec,
            StrategyOnlyMoveStrategy,
            StrategyOnlyMoveStrategy,
        >(
            StrategyOnlyProtocol,
            StrategyOnlyMoveStrategy,
            StrategyOnlyMoveStrategy,
            &kit,
            "0xabc124",
            100,
            100,
            1234567890,
            10,
            AnchorMode::Memory,
            TranscriptRecorderMode::Memory,
            |_, _| {},
        );

        assert_eq!(result.moves, 1);
        assert_eq!(result.transcript_entries, 2);
    }
}
