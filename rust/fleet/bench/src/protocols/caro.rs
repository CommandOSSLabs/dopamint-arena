use super::{
    current_initial_balance, current_max_moves_per_tunnel, play_with_strategies, MAX_MOVES,
};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{SeatKit, TunnelOutcome};
use tunnel_caro::{Caro, CaroSeries, CaroSeriesStrategy, CaroStrategy, CaroStrength};

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
    let initial_balance = current_initial_balance();
    play_with_strategies(
        Caro::default(),
        CaroStrategy::with_seed(15, CaroStrength::Strong, seed ^ 0xA5A5_5A5A_D0D0_1CE5)
            .expect("valid caro strategy"),
        CaroStrategy::with_seed(15, CaroStrength::Strong, seed ^ 0x5A5A_A5A5_CAFE_BABE)
            .expect("valid caro strategy"),
        codec,
        anchor_mode,
        sui_context,
        seed,
        kit,
        tunnel_id,
        initial_balance,
        initial_balance,
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
    let initial_balance = current_initial_balance();
    let max_games = current_max_moves_per_tunnel().max(1);
    play_with_strategies(
        CaroSeries::new(max_games, 15, 0).expect("valid caro series"),
        CaroSeriesStrategy::with_seed(
            max_games,
            15,
            CaroStrength::Strong,
            seed ^ 0xA5A5_5A5A_D0D0_1CE5,
        )
        .expect("valid caro series strategy"),
        CaroSeriesStrategy::with_seed(
            max_games,
            15,
            CaroStrength::Strong,
            seed ^ 0x5A5A_A5A5_CAFE_BABE,
        )
        .expect("valid caro series strategy"),
        codec,
        anchor_mode,
        sui_context,
        seed,
        kit,
        tunnel_id,
        initial_balance,
        initial_balance,
        MAX_MOVES,
        telemetry,
    )
    .await
}
