use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::{AnchorMode, FrameCodecKind, TranscriptRecorderMode};
use crate::party_driver::SuiSponsoredBenchContext;
use crate::party_driver::{MatchResult, SeatKit};
use tunnel_caro::{Caro, CaroSeries, CaroSeriesStrategy, CaroStrategy, CaroStrength};

pub(crate) fn play_single(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    let seed = card_seed.unwrap_or(0);
    play_with_strategies(
        Caro::default(),
        CaroStrategy::with_seed(15, CaroStrength::Strong, seed ^ 0xA5A5_5A5A_D0D0_1CE5)
            .expect("valid caro strategy"),
        CaroStrategy::with_seed(15, CaroStrength::Strong, seed ^ 0x5A5A_A5A5_CAFE_BABE)
            .expect("valid caro strategy"),
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

pub(crate) fn play_series(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    transcript_recorder: TranscriptRecorderMode,
) -> MatchResult {
    let seed = card_seed.unwrap_or(0);
    play_with_strategies(
        CaroSeries::new(3, 15).expect("valid caro series"),
        CaroSeriesStrategy::with_seed(3, 15, CaroStrength::Strong, seed ^ 0xA5A5_5A5A_D0D0_1CE5)
            .expect("valid caro series strategy"),
        CaroSeriesStrategy::with_seed(3, 15, CaroStrength::Strong, seed ^ 0x5A5A_A5A5_CAFE_BABE)
            .expect("valid caro series strategy"),
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
