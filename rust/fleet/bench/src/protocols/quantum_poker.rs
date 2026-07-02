use super::{
    current_initial_balance, current_max_moves_per_tunnel, play_with_strategies, MAX_MOVES,
};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{SeatKit, TunnelOutcome};
use tunnel_quantum_poker::{QuantumPoker, QuantumPokerStrategy};

const BENCH_QUANTUM_POKER_ANTE: u64 = 1;

fn bench_quantum_poker_protocol(hand_cap: u64) -> QuantumPoker {
    QuantumPoker::with_ante(hand_cap, BENCH_QUANTUM_POKER_ANTE)
}

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
    play_with_strategies(
        bench_quantum_poker_protocol(current_max_moves_per_tunnel()),
        QuantumPokerStrategy::conservative(seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        QuantumPokerStrategy::conservative(seed ^ 0x5A5A_A5A5_CAFE_BABE),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bench_quantum_poker_uses_minimum_ante() {
        let protocol = bench_quantum_poker_protocol(1_000);

        assert_eq!(protocol.ante(), 1);
    }
}
