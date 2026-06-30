use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::SuiSponsoredBenchContext;
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
    let protocol = WorldCanvasCell::new(256, 16, MAX_MOVES).expect("valid cell canvas");
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
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
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
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
        telemetry,
    )
    .await
}
