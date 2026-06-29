use crate::cli::{AnchorMode, FrameCodecKind, TranscriptRecorderMode};
use crate::party_driver::{play_protocol_match_with_strategies, MatchResult, SeatKit};
use tunnel_core::protocol_id::{
    API_CREDITS_V1, BATTLESHIP_SERIES_V1, BATTLESHIP_V1, BLACKJACK_BET_V1, BLACKJACK_DUEL_V1,
    BLACKJACK_V2, BOMB_IT_SERIES_V1, BOMB_IT_V1, CARO_SERIES_V1, CARO_V1, CHAT_V1, CROSS_SERIES_V1,
    CROSS_V1, PAYMENTS_V1, QUANTUM_POKER_V2, TIC_TAC_TOE_SERIES_V1, TIC_TAC_TOE_V1,
    WORLD_CANVAS_CELL_V1, WORLD_CANVAS_STROKE_V1,
};
use tunnel_harness::{
    BcsFrameCodec, FrameCodec, JsonFrameCodec, MoveStrategy, PostcardFrameCodec, Protocol,
};

pub(crate) mod api_credits;
pub(crate) mod battleship;
pub(crate) mod blackjack;
pub(crate) mod bomb_it;
pub(crate) mod caro;
pub(crate) mod chat;
pub(crate) mod cross;
pub(crate) mod payments;
pub(crate) mod quantum_poker;
pub(crate) mod tic_tac_toe;
pub(crate) mod world_canvas;

pub(crate) const CREATED_AT: u64 = 1234567890;
pub(crate) const MAX_MOVES: u64 = 1000;
pub(crate) const DEFAULT_BALANCE: u64 = 200;

#[allow(clippy::too_many_arguments)]
pub(crate) fn play_with_strategies<P, StrategyA, StrategyB>(
    protocol: P,
    strategy_a: StrategyA,
    strategy_b: StrategyB,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    transcript_recorder: TranscriptRecorderMode,
    move_seed: u64,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    max_moves: u64,
) -> MatchResult
where
    P: Protocol + Clone,
    P::Move: Clone,
    StrategyA: MoveStrategy<P>,
    StrategyB: MoveStrategy<P>,
{
    match codec {
        FrameCodecKind::Json => play_with_codec::<P, JsonFrameCodec, StrategyA, StrategyB>(
            protocol,
            strategy_a,
            strategy_b,
            move_seed,
            kit,
            tunnel_id,
            balance_a,
            balance_b,
            max_moves,
            anchor_mode,
            transcript_recorder,
        ),
        FrameCodecKind::Bcs => play_with_codec::<P, BcsFrameCodec, StrategyA, StrategyB>(
            protocol,
            strategy_a,
            strategy_b,
            move_seed,
            kit,
            tunnel_id,
            balance_a,
            balance_b,
            max_moves,
            anchor_mode,
            transcript_recorder,
        ),
        FrameCodecKind::Postcard => play_with_codec::<P, PostcardFrameCodec, StrategyA, StrategyB>(
            protocol,
            strategy_a,
            strategy_b,
            move_seed,
            kit,
            tunnel_id,
            balance_a,
            balance_b,
            max_moves,
            anchor_mode,
            transcript_recorder,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn play_with_codec<P, C, StrategyA, StrategyB>(
    protocol: P,
    strategy_a: StrategyA,
    strategy_b: StrategyB,
    _move_seed: u64,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    max_moves: u64,
    anchor_mode: AnchorMode,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult
where
    P: Protocol + Clone,
    P::Move: Clone,
    C: FrameCodec<P::Move> + Default,
    StrategyA: MoveStrategy<P>,
    StrategyB: MoveStrategy<P>,
{
    play_protocol_match_with_strategies::<P, C, StrategyA, StrategyB>(
        protocol,
        strategy_a,
        strategy_b,
        kit,
        tunnel_id,
        balance_a,
        balance_b,
        CREATED_AT,
        max_moves,
        anchor_mode,
        transcript_recorder,
        |_, _| {},
    )
}

pub(crate) fn play_match_for(
    protocol_id: &'static str,
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    match protocol_id {
        API_CREDITS_V1 => api_credits::play(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        BATTLESHIP_V1 => battleship::play_single(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        BATTLESHIP_SERIES_V1 => battleship::play_series(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        BLACKJACK_BET_V1 => blackjack::play_bet(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        BLACKJACK_DUEL_V1 => blackjack::play_duel(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        BLACKJACK_V2 => blackjack::play_v2(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        BOMB_IT_V1 => bomb_it::play_single(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        BOMB_IT_SERIES_V1 => bomb_it::play_series(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        CARO_V1 => caro::play_single(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        CARO_SERIES_V1 => caro::play_series(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        CHAT_V1 => chat::play(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        CROSS_V1 => cross::play_single(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        CROSS_SERIES_V1 => cross::play_series(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        PAYMENTS_V1 => payments::play(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        QUANTUM_POKER_V2 => quantum_poker::play(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        TIC_TAC_TOE_V1 => tic_tac_toe::play_single(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        TIC_TAC_TOE_SERIES_V1 => tic_tac_toe::play_series(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        WORLD_CANVAS_CELL_V1 => world_canvas::play_cell(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        WORLD_CANVAS_STROKE_V1 => world_canvas::play_stroke(
            codec,
            card_seed,
            kit,
            tunnel_id,
            anchor_mode,
            transcript_recorder,
        ),
        _ => panic!("unsupported fleet-bench protocol id: {protocol_id}"),
    }
}
