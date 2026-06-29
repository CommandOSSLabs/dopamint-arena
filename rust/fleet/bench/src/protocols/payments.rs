use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind, TranscriptRecorderMode};
use crate::party_driver::{MatchResult, SeatKit};
use tunnel_payments::{Payments, PaymentsStrategy};

pub(crate) fn play(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    let payment_amount = 5;
    play_with_strategies(
        Payments {
            max_transfers: MAX_MOVES,
        },
        PaymentsStrategy::new(payment_amount).expect("valid payments strategy"),
        PaymentsStrategy::new(payment_amount).expect("valid payments strategy"),
        codec,
        anchor_mode,
        transcript_recorder,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
    )
}
