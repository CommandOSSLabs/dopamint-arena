use super::{play_with_strategies, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::FrameCodecKind;
use crate::party_driver::{MatchResult, SeatKit};
use tunnel_caro::{Caro, CaroSeries, CaroSeriesStrategy, CaroStrategy};

pub(crate) fn play_single(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
) -> MatchResult {
    play_with_strategies(
        Caro::default(),
        CaroStrategy::default(),
        CaroStrategy::default(),
        codec,
        card_seed.unwrap_or(0),
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
) -> MatchResult {
    play_with_strategies(
        CaroSeries::new(3, 15).expect("valid caro series"),
        CaroSeriesStrategy::new(3, 15).expect("valid caro series strategy"),
        CaroSeriesStrategy::new(3, 15).expect("valid caro series strategy"),
        codec,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
    )
}
