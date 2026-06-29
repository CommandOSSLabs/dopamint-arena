use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind, SuiAnchorOpts, TranscriptRecorderMode};
use crate::party_driver::{MatchResult, SeatKit};
use tunnel_bomb_it::{BombIt, BombItSeries, BombItSeriesStrategy, BombItStrategy};

pub(crate) fn play_single(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_anchor: Option<&SuiAnchorOpts>,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    let seed = card_seed.unwrap_or(0);
    play_with_strategies(
        BombIt,
        BombItStrategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        BombItStrategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE),
        codec,
        anchor_mode,
        sui_anchor,
        transcript_recorder,
        seed,
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
    )
}

pub(crate) fn play_series(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_anchor: Option<&SuiAnchorOpts>,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    let seed = card_seed.unwrap_or(0);
    play_with_strategies(
        BombItSeries::new(tunnel_id, 100),
        BombItSeriesStrategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5, 100),
        BombItSeriesStrategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE, 100),
        codec,
        anchor_mode,
        sui_anchor,
        transcript_recorder,
        seed,
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
    )
}
