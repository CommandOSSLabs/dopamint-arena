use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{SeatKit, TunnelOutcome};
use tunnel_battleship::{
    Battleship, BattleshipSeries, BattleshipSeriesStrategy, BattleshipStrategy,
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
        Battleship::default(),
        BattleshipStrategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        BattleshipStrategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE),
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
        BattleshipSeries::new(tunnel_id, 100),
        BattleshipSeriesStrategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5, 100),
        BattleshipSeriesStrategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE, 100),
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
