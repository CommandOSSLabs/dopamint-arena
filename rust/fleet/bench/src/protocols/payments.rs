use super::{current_initial_balance, play_with_strategies, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::{SeatKit, TunnelOutcome};
use tunnel_payments::{Payments, PaymentsStrategy};

pub(crate) async fn play(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    telemetry: TunnelTelemetry,
) -> TunnelOutcome {
    let initial_balance = current_initial_balance();
    let payment_amount = initial_balance.min(5);
    let max_transfers = initial_balance / payment_amount;
    play_with_strategies(
        Payments { max_transfers },
        PaymentsStrategy::new(payment_amount).expect("valid payments strategy"),
        PaymentsStrategy::new(payment_amount).expect("valid payments strategy"),
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
