use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::SeatKit;
use crate::party_driver::{SeededBlackjack, SuiSponsoredBenchContext, TunnelOutcome};
use tunnel_blackjack::duel::BlackjackDuel;
use tunnel_blackjack::v2::{BlackjackV2, BlackjackV2Strategy};
use tunnel_blackjack::{BlackjackDuelStrategy, BlackjackStrategy};

pub(crate) async fn play_bet(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    telemetry: TunnelTelemetry,
) -> TunnelOutcome {
    // SeededBlackjack injects the card_seed into Protocol::initial_state,
    // replacing the old configure-hook approach.
    play_with_strategies(
        SeededBlackjack { card_seed },
        BlackjackStrategy,
        BlackjackStrategy,
        codec,
        anchor_mode,
        sui_context,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
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
        20_000_000,
        20_000_000,
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
    play_with_strategies(
        BlackjackV2,
        BlackjackV2Strategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        BlackjackV2Strategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE),
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
