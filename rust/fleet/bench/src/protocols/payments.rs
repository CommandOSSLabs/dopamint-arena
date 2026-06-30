use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::FrameCodecKind;
use crate::party_driver::{MatchResult, SeatKit};
use tunnel_payments::{Payments, PaymentsStrategy};

pub(crate) fn play(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
) -> MatchResult {
    let payment_amount = 5;
    play_with_strategies(
        Payments {
            max_transfers: MAX_MOVES,
        },
        PaymentsStrategy::new(payment_amount).expect("valid payments strategy"),
        PaymentsStrategy::new(payment_amount).expect("valid payments strategy"),
        codec,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
    )
}
