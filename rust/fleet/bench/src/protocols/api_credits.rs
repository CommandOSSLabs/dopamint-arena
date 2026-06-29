use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind, TranscriptRecorderMode};
use crate::party_driver::SuiBenchContext;
use crate::party_driver::{MatchResult, SeatKit};
use tunnel_api_credits::{ApiCredits, ApiCreditsStrategy};

pub(crate) fn play(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiBenchContext>,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    let cost_per_call = 10;
    play_with_strategies(
        ApiCredits::new(cost_per_call).expect("valid api credit cost"),
        ApiCreditsStrategy::new(cost_per_call).expect("valid api credit strategy"),
        ApiCreditsStrategy::new(cost_per_call).expect("valid api credit strategy"),
        codec,
        anchor_mode,
        sui_context,
        transcript_recorder,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
    )
}
