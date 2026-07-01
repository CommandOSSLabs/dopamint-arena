use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{SeatKit, TunnelOutcome};
use tunnel_tic_tac_toe::{
    TicTacToe, TicTacToeDifficulty, TicTacToeSeries, TicTacToeSeriesStrategy, TicTacToeStrategy,
};

pub(crate) async fn play_single(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    telemetry: TunnelTelemetry,
) -> TunnelOutcome {
    let seed = card_seed.unwrap_or(0);
    play_with_strategies(
        TicTacToe::default(),
        TicTacToeStrategy::new(TicTacToeDifficulty::Perfect, seed as u32),
        TicTacToeStrategy::new(TicTacToeDifficulty::Perfect, (seed ^ 0x5A5A_A5A5) as u32),
        codec,
        anchor_mode,
        sui_context,
        seed,
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
        telemetry,
    )
    .await
}

pub(crate) async fn play_series(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    telemetry: TunnelTelemetry,
) -> TunnelOutcome {
    let seed = card_seed.unwrap_or(0);
    play_with_strategies(
        TicTacToeSeries::new(3, 100).expect("valid ttt series"),
        TicTacToeSeriesStrategy::new(TicTacToeDifficulty::Perfect, seed as u32),
        TicTacToeSeriesStrategy::new(TicTacToeDifficulty::Perfect, (seed ^ 0x5A5A_A5A5) as u32),
        codec,
        anchor_mode,
        sui_context,
        seed,
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
        telemetry,
    )
    .await
}
