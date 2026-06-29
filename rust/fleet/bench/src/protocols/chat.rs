use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind, TranscriptRecorderMode};
use crate::party_driver::SuiBenchContext;
use crate::party_driver::{MatchResult, SeatKit};
use tunnel_chat::{Chat, ChatStrategy};

pub(crate) fn play(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiBenchContext>,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    let seed = card_seed.unwrap_or(0);
    play_with_strategies(
        Chat,
        ChatStrategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        ChatStrategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE),
        codec,
        anchor_mode,
        sui_context,
        transcript_recorder,
        seed,
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
    )
}
