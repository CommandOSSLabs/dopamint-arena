use super::{
    current_initial_balance, current_max_moves_per_tunnel, play_with_strategies, MAX_MOVES,
};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{SeatKit, TunnelOutcome};
use tunnel_world_canvas::{
    WorldCanvasCell, WorldCanvasCellStrategy, WorldCanvasStroke, WorldCanvasStrokeStrategy,
};

pub(crate) async fn play_cell(
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
    let max_moves = current_max_moves_per_tunnel().max(MAX_MOVES);
    let protocol = WorldCanvasCell::new(256, 16, max_moves).expect("valid cell canvas");
    play_with_strategies(
        protocol,
        WorldCanvasCellStrategy::new(protocol, seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        WorldCanvasCellStrategy::new(protocol, seed ^ 0x5A5A_A5A5_CAFE_BABE),
        codec,
        anchor_mode,
        sui_context,
        seed,
        kit,
        tunnel_id,
        initial_balance,
        initial_balance,
        max_moves,
        telemetry,
    )
    .await
}

pub(crate) async fn play_stroke(
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
        WorldCanvasStroke,
        WorldCanvasStrokeStrategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        WorldCanvasStrokeStrategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE),
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
