use super::{play_with_strategies, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{SeatKit, TunnelOutcome};
use tunnel_quantum_poker::{QuantumPoker, QuantumPokerStrategy};

pub(crate) async fn play(
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
        QuantumPoker::new(3),
        QuantumPokerStrategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        QuantumPokerStrategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE),
        codec,
        anchor_mode,
        sui_context,
        seed,
        kit,
        tunnel_id,
        2_000,
        2_000,
        MAX_MOVES,
        telemetry,
    )
    .await
}
