use super::{play_with_strategies, CREATED_AT, DEFAULT_BALANCE, MAX_MOVES};
use crate::cli::FrameCodecKind;
use crate::party_driver::{play_protocol_match_with_strategies, MatchResult, SeatKit};
use tunnel_blackjack::duel::BlackjackDuel;
use tunnel_blackjack::v2::{BlackjackV2, BlackjackV2Strategy};
use tunnel_blackjack::{BjMove, Blackjack, BlackjackDuelStrategy, BlackjackStrategy};
use tunnel_harness::{BcsFrameCodec, FrameCodec, JsonFrameCodec, PostcardFrameCodec};

pub(crate) fn play_bet(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
) -> MatchResult {
    match codec {
        FrameCodecKind::Json => play_bet_with_codec::<JsonFrameCodec>(card_seed, kit, tunnel_id),
        FrameCodecKind::Bcs => play_bet_with_codec::<BcsFrameCodec>(card_seed, kit, tunnel_id),
        FrameCodecKind::Postcard => {
            play_bet_with_codec::<PostcardFrameCodec>(card_seed, kit, tunnel_id)
        }
    }
}

fn play_bet_with_codec<C>(card_seed: Option<u64>, kit: &SeatKit, tunnel_id: &str) -> MatchResult
where
    C: FrameCodec<BjMove> + Default,
{
    play_protocol_match_with_strategies::<Blackjack, C, BlackjackStrategy, BlackjackStrategy>(
        Blackjack,
        BlackjackStrategy,
        BlackjackStrategy,
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        CREATED_AT,
        MAX_MOVES,
        |a, b| {
            if card_seed.is_some() {
                a.with_state_mut(|s| s.card_seed = card_seed);
                b.with_state_mut(|s| s.card_seed = card_seed);
            }
        },
    )
}

pub(crate) fn play_duel(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
) -> MatchResult {
    play_with_strategies(
        BlackjackDuel,
        BlackjackDuelStrategy,
        BlackjackDuelStrategy,
        codec,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        20_000_000,
        20_000_000,
        MAX_MOVES,
    )
}

pub(crate) fn play_v2(
    codec: FrameCodecKind,
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
) -> MatchResult {
    let seed = card_seed.unwrap_or(0);
    play_with_strategies(
        BlackjackV2,
        BlackjackV2Strategy::new(seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        BlackjackV2Strategy::new(seed ^ 0x5A5A_A5A5_CAFE_BABE),
        codec,
        seed,
        kit,
        tunnel_id,
        DEFAULT_BALANCE,
        DEFAULT_BALANCE,
        MAX_MOVES,
    )
}
