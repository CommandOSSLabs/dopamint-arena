use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind};
use crate::party_driver::TunnelTelemetry;
use crate::party_driver::SuiSponsoredBenchContext;
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
    let payment_amount = 5;
    let max_transfers = DEFAULT_BALANCE / payment_amount;
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
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
        telemetry,
    )
    .await
}
