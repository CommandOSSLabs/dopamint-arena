use super::{
    current_initial_balance, current_max_moves_per_tunnel, play_with_strategies, MAX_MOVES,
};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SeatKit;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{
    SeededBlackjack, SeededBlackjackStrategy, SuiSponsoredBenchContext, TunnelOutcome,
};
use tunnel_blackjack::duel::BlackjackDuel;
use tunnel_blackjack::v2::{BlackjackV2WithRoundCap, BlackjackV2WithRoundCapStrategy};
use tunnel_blackjack::BlackjackDuelStrategy;

pub(crate) async fn play_bet(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    telemetry: TunnelTelemetry,
) -> TunnelOutcome {
    let initial_balance = current_initial_balance();
    // SeededBlackjack injects the card_seed into Protocol::initial_state,
    // replacing the old configure-hook approach.
    play_with_strategies(
        SeededBlackjack {
            card_seed,
            round_cap: current_max_moves_per_tunnel(),
        },
        SeededBlackjackStrategy {
            round_cap: current_max_moves_per_tunnel(),
        },
        SeededBlackjackStrategy {
            round_cap: current_max_moves_per_tunnel(),
        },
        codec,
        anchor_mode,
        sui_context,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        initial_balance,
        initial_balance,
        MAX_MOVES,
        telemetry,
    )
    .await
}

pub(crate) async fn play_duel(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    telemetry: TunnelTelemetry,
) -> TunnelOutcome {
    let initial_balance = current_initial_balance();
    play_with_strategies(
        BlackjackDuel,
        BlackjackDuelStrategy,
        BlackjackDuelStrategy,
        codec,
        anchor_mode,
        sui_context,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        initial_balance,
        initial_balance,
        MAX_MOVES,
        telemetry,
    )
    .await
}

pub(crate) async fn play_v2(
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
    let protocol = BlackjackV2WithRoundCap::new(current_max_moves_per_tunnel());
    let round_cap = current_max_moves_per_tunnel();
    play_with_strategies(
        protocol,
        bench_blackjack_v2_strategy(seed ^ 0xA5A5_5A5A_D0D0_1CE5, round_cap),
        bench_blackjack_v2_strategy(seed ^ 0x5A5A_A5A5_CAFE_BABE, round_cap),
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

fn bench_blackjack_v2_strategy(seed: u64, round_cap: u64) -> BlackjackV2WithRoundCapStrategy {
    BlackjackV2WithRoundCapStrategy::with_wager(seed, round_cap, tunnel_blackjack::v2::MIN_BET)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::{MoveStrategy, MoveStrategyContext, Protocol, Seat};

    #[tokio::test]
    async fn bench_blackjack_v2_strategy_uses_minimum_legal_wager() {
        let protocol = BlackjackV2WithRoundCap::new(1_000);
        let state = protocol.initial_state(&tunnel_harness::TunnelContext {
            tunnel_id: "0x1".into(),
            initial: tunnel_harness::Balances { a: 200, b: 200 },
            seat: Seat::A,
        });
        let mut strategy = bench_blackjack_v2_strategy(1, 1_000);

        let planned = strategy
            .plan_move(
                &state,
                Seat::A,
                &MoveStrategyContext {
                    tunnel_id: "0x1".into(),
                    seat: Seat::A,
                },
            )
            .await
            .expect("seat A opens round one");

        assert_eq!(
            planned,
            tunnel_blackjack::v2::BlackjackV2Move::Bet {
                amount: tunnel_blackjack::v2::MIN_BET,
            }
        );
    }
}
