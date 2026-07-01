use super::{current_initial_balance, play_with_strategies, MAX_MOVES};
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
    let initial_balance = current_initial_balance();
    let ante = initial_balance.min(tunnel_quantum_poker::ANTE);
    play_with_strategies(
        QuantumPoker::with_ante(3, ante),
        QuantumPokerStrategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        QuantumPokerStrategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE),
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
