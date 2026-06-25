//! Variable-bet player-vs-dealer Blackjack, byte-exact with
//! `frontend/src/games/blackjack/app/lib/bjBetProtocol.ts`. Dealerless: every card
//! comes from a deterministic per-round byte stream, so both seats (and an on-chain
//! replay of `encode_state`) agree on the cards. Party A = player, B = dealer, with a
//! 2-round rotation of the player role.

use crate::engine::codec::u64_to_be_bytes;
use crate::engine::crypto::blake2b256;

pub const MIN_BET: u64 = 25;
pub const BET_OPTIONS: [u64; 4] = [25, 100, 500, 1000];
const DEALER_STANDS_AT: u32 = 17;
const BUST_AT: u32 = 21;
const ROUND_CAP: u64 = 1000;

/// `protocolDomain("blackjack.bet.v1")` = `sui_tunnel::proto::` + name.
const DOMAIN: &[u8] = b"sui_tunnel::proto::blackjack.bet.v1";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase { RoundOver, Player, Dealer }

impl Phase {
    fn code(self) -> u8 {
        match self { Phase::RoundOver => 0, Phase::Player => 1, Phase::Dealer => 2 }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Party { A, B }

impl Party {
    pub fn other(self) -> Party { match self { Party::A => Party::B, Party::B => Party::A } }
}

#[derive(Clone, Copy, Debug)]
pub enum BjMove { Bet { amount: u64 }, Hit, Stand }

#[derive(Clone, Debug)]
pub struct BjState {
    pub phase: Phase,
    pub round: u64,
    pub draw_index: u64,
    pub player_hand: Vec<u8>,
    pub dealer_hand: Vec<u8>,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
    pub bet: u64,
}

/// Seat holding the PLAYER role in `round` (1-based). Swaps every two rounds.
pub fn player_party(round: u64) -> Party {
    // round - 1, then floor(/2) % 2; round 0 is treated like the TS Number(round)-1 = -1
    // path only via actor_for(round+1), so round >= 1 here in practice.
    let r = (round as i64) - 1;
    if (r.div_euclid(2)) % 2 == 0 { Party::A } else { Party::B }
}

pub fn dealer_party(round: u64) -> Party { player_party(round).other() }

/// The seat the protocol expects to act next. In `round_over` the NEXT round's player bets.
pub fn actor_for(s: &BjState) -> Party {
    match s.phase {
        Phase::Player => player_party(s.round),
        Phase::Dealer => dealer_party(s.round),
        Phase::RoundOver => player_party(s.round + 1),
    }
}

/// Deterministic card stream: `seed = blake2b256(DOMAIN || u64be(round))`, one byte per
/// draw, advancing a fresh digest every 32 draws via `blake2b256(digest || u64be(block))`.
fn draw_rank(round: u64, draw_index: u64) -> u8 {
    let mut buf = Vec::with_capacity(DOMAIN.len() + 8);
    buf.extend_from_slice(DOMAIN);
    buf.extend_from_slice(&u64_to_be_bytes(round));
    let mut digest = blake2b256(&buf);
    let idx = draw_index as usize;
    let block = idx / 32;
    for b in 0..block {
        let mut next = Vec::with_capacity(32 + 8);
        next.extend_from_slice(&digest);
        next.extend_from_slice(&u64_to_be_bytes(b as u64));
        digest = blake2b256(&next);
    }
    (digest[idx % 32] % 13) + 1
}

/// Map a rank (1..13) to its blackjack value (Ace = 11; downgraded later).
fn rank_value(rank: u8) -> u8 {
    if rank == 1 { 11 } else if rank >= 11 { 10 } else { rank }
}

/// Hand total with soft-ace handling: downgrade an 11 to 1 per ace while busting.
pub fn hand_value(hand: &[u8]) -> u32 {
    let mut total: u32 = 0;
    let mut aces: u32 = 0;
    for &v in hand {
        total += v as u32;
        if v == 11 { aces += 1; }
    }
    while total > BUST_AT && aces > 0 { total -= 10; aces -= 1; }
    total
}

fn is_bust(hand: &[u8]) -> bool { hand_value(hand) > BUST_AT }

/// Largest bet both sides can cover this round.
pub fn max_bet(s: &BjState) -> u64 { s.balance_a.min(s.balance_b) }

pub fn initial_state(balance_a: u64, balance_b: u64) -> BjState {
    BjState {
        phase: Phase::RoundOver,
        round: 0,
        draw_index: 0,
        player_hand: Vec::new(),
        dealer_hand: Vec::new(),
        balance_a,
        balance_b,
        total: balance_a + balance_b,
        bet: 0,
    }
}

pub fn is_terminal(s: &BjState) -> bool {
    s.round >= ROUND_CAP || (s.phase == Phase::RoundOver && max_bet(s) < MIN_BET)
}

fn draw_to(hand: &mut Vec<u8>, round: u64, draw_index: u64) -> u64 {
    hand.push(rank_value(draw_rank(round, draw_index)));
    draw_index + 1
}

fn deal_round(s: &BjState, bet: u64) -> BjState {
    let round = s.round + 1;
    let mut draw_index = 0u64;
    let mut player_hand = Vec::new();
    let mut dealer_hand = Vec::new();
    for _ in 0..2 { draw_index = draw_to(&mut player_hand, round, draw_index); }
    for _ in 0..2 { draw_index = draw_to(&mut dealer_hand, round, draw_index); }
    BjState { phase: Phase::Player, round, draw_index, player_hand, dealer_hand, bet, ..s.clone() }
}

fn resolve_dealer(s: &BjState) -> BjState {
    let mut hand = s.dealer_hand.clone();
    let mut draw_index = s.draw_index;
    while hand_value(&hand) < DEALER_STANDS_AT {
        draw_index = draw_to(&mut hand, s.round, draw_index);
    }
    let mut resolved = s.clone();
    resolved.dealer_hand = hand;
    resolved.draw_index = draw_index;
    let pv = hand_value(&resolved.player_hand);
    let dv = hand_value(&resolved.dealer_hand);
    let player = player_party(s.round);
    let dealer = player.other();
    // Dealer bust and outright higher hand both award the player.
    let winner = if is_bust(&resolved.dealer_hand) || pv > dv {
        Some(player)
    } else if dv > pv {
        Some(dealer)
    } else {
        None
    };
    settle(&resolved, winner)
}

fn settle(s: &BjState, winner: Option<Party>) -> BjState {
    let mut balance_a = s.balance_a;
    let mut balance_b = s.balance_b;
    match winner {
        Some(Party::A) => { let amt = s.bet.min(balance_b); balance_a += amt; balance_b -= amt; }
        Some(Party::B) => { let amt = s.bet.min(balance_a); balance_b += amt; balance_a -= amt; }
        None => {}
    }
    BjState { phase: Phase::RoundOver, balance_a, balance_b, ..s.clone() }
}

pub fn apply_move(s: &BjState, mv: BjMove, by: Party) -> Result<BjState, String> {
    match s.phase {
        Phase::RoundOver => {
            let BjMove::Bet { amount } = mv else { return Err("place a bet to start the round".into()); };
            let next_player = player_party(s.round + 1);
            if by != next_player { return Err(format!("only the player ({next_player:?}) sets the bet")); }
            if is_terminal(s) { return Err("game over: a side cannot fund another bet".into()); }
            let cap = max_bet(s);
            if amount < MIN_BET || amount > cap { return Err(format!("bet must be {MIN_BET}..{cap}")); }
            Ok(deal_round(s, amount))
        }
        Phase::Player => {
            if by != player_party(s.round) { return Err("not the player's turn".into()); }
            match mv {
                BjMove::Hit => {
                    let mut next = s.clone();
                    next.draw_index = draw_to(&mut next.player_hand, s.round, s.draw_index);
                    if is_bust(&next.player_hand) { Ok(settle(&next, Some(dealer_party(s.round)))) } else { Ok(next) }
                }
                BjMove::Stand => Ok(BjState { phase: Phase::Dealer, ..s.clone() }),
                BjMove::Bet { .. } => Err("invalid player action".into()),
            }
        }
        Phase::Dealer => {
            if by != dealer_party(s.round) { return Err("not the dealer's turn".into()); }
            match mv {
                BjMove::Stand => Ok(resolve_dealer(s)),
                _ => Err("the dealer only stands (auto-play)".into()),
            }
        }
    }
}

/// Byte-exact with `bjBetProtocol.ts::encodeState`.
pub fn encode_state(s: &BjState) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(DOMAIN);
    out.extend_from_slice(&u64_to_be_bytes(s.balance_a));
    out.extend_from_slice(&u64_to_be_bytes(s.balance_b));
    out.extend_from_slice(&u64_to_be_bytes(s.round));
    out.extend_from_slice(&u64_to_be_bytes(s.draw_index));
    out.push(s.phase.code());
    out.extend_from_slice(&u64_to_be_bytes(s.bet));
    out.extend_from_slice(&u64_to_be_bytes(s.player_hand.len() as u64));
    out.extend_from_slice(&s.player_hand);
    out.extend_from_slice(&u64_to_be_bytes(s.dealer_hand.len() as u64));
    out.extend_from_slice(&s.dealer_hand);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::crypto::blake2b256;

    // tunnelId/keys are irrelevant to the protocol; balances 200/200.
    #[test]
    fn initial_state_encodes_to_golden() {
        let s = initial_state(200, 200);
        assert_eq!(hex::encode(encode_state(&s)),
            "7375695f74756e6e656c3a3a70726f746f3a3a626c61636b6a61636b2e6265742e763100000000000000c800000000000000c80000000000000000000000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(hex::encode(blake2b256(&encode_state(&s))),
            "9af0532be79ef5264245875dacee60321f2d1ae4c1920cf37eb841d8e2da68eb");
    }

    #[test]
    fn first_round_deal_matches_golden() {
        // round_over -> player A bets 25 -> deal round 1.
        let s = initial_state(200, 200);
        let s1 = apply_move(&s, BjMove::Bet { amount: 25 }, Party::A).unwrap();
        assert_eq!(s1.player_hand, vec![10, 7]);
        assert_eq!(s1.dealer_hand, vec![10, 3]);
        assert_eq!(s1.draw_index, 4);
        assert!(matches!(s1.phase, Phase::Player));
        assert_eq!(s1.bet, 25);
        assert_eq!(hex::encode(encode_state(&s1)),
            "7375695f74756e6e656c3a3a70726f746f3a3a626c61636b6a61636b2e6265742e763100000000000000c800000000000000c80000000000000001000000000000000401000000000000001900000000000000020a0700000000000000020a03");
        assert_eq!(hex::encode(blake2b256(&encode_state(&s1))),
            "c217301ef203ccbe2a1f946e6a420cd8a7853cace315bfc9adca56d7162d9219");
    }

    #[test]
    fn hand_value_soft_ace() {
        assert_eq!(hand_value(&[11, 7]), 18);     // soft 18
        assert_eq!(hand_value(&[11, 7, 10]), 18); // ace downgraded once: 1+7+10
        assert_eq!(hand_value(&[10, 3]), 13);
    }

    #[test]
    fn balances_always_sum_to_total() {
        // Play a full match's worth of moves via basic strategy; sum is invariant.
        let mut s = initial_state(200, 200);
        for _ in 0..400 {
            if is_terminal(&s) { break; }
            let by = actor_for(&s);
            let mv = match s.phase {
                Phase::RoundOver => BjMove::Bet { amount: 25 },
                Phase::Player => if hand_value(&s.player_hand) < 17 { BjMove::Hit } else { BjMove::Stand },
                Phase::Dealer => BjMove::Stand,
            };
            s = apply_move(&s, mv, by).unwrap();
            assert_eq!(s.balance_a + s.balance_b, 400);
        }
        assert!(is_terminal(&s));
    }

    #[test]
    fn wrong_turn_is_rejected() {
        let s = initial_state(200, 200);
        // round 1 player is A; B may not bet.
        assert!(apply_move(&s, BjMove::Bet { amount: 25 }, Party::B).is_err());
    }
}

/// loadbench `BlackjackBot.plan`: deterministic basic strategy. Returns `None` when it
/// is not `seat`'s turn. Bet = the first `BET_OPTIONS` entry within `[MIN_BET, max_bet]`
/// (always 25 when affordable); player hits while `hand_value < 17`, else stands; dealer
/// stands. Mirrors `frontend/src/agent/games/blackjack/kit.ts::BlackjackBot`.
pub fn plan(s: &BjState, seat: Party) -> Option<BjMove> {
    if is_terminal(s) { return None; }
    if actor_for(s) != seat { return None; }
    match s.phase {
        Phase::RoundOver => {
            let cap = max_bet(s);
            let amount = BET_OPTIONS.iter().copied().find(|&o| o >= MIN_BET && o <= cap).unwrap_or(MIN_BET);
            // fixedBetMove clamps to [MIN_BET, cap]; amount is already in range when cap >= MIN_BET.
            let amount = amount.clamp(MIN_BET, cap);
            Some(BjMove::Bet { amount })
        }
        Phase::Player => {
            if seat != player_party(s.round) { return None; }
            Some(if hand_value(&s.player_hand) < 17 { BjMove::Hit } else { BjMove::Stand })
        }
        Phase::Dealer => {
            if seat != dealer_party(s.round) { return None; }
            Some(BjMove::Stand)
        }
    }
}

#[cfg(test)]
mod bot_tests {
    use super::*;

    #[test]
    fn round_over_player_bets_min_option() {
        let s = initial_state(200, 200);
        // round 1 player is A; A bets 25 (first BET_OPTIONS entry that fits).
        assert!(matches!(plan(&s, Party::A), Some(BjMove::Bet { amount: 25 })));
        // B is not the next player -> None.
        assert!(plan(&s, Party::B).is_none());
    }

    #[test]
    fn player_hits_below_17_then_stands() {
        let s = initial_state(200, 200);
        let s1 = apply_move(&s, BjMove::Bet { amount: 25 }, Party::A).unwrap();
        // player hand [10,7] = 17 -> stand; dealer's seat plans None here.
        assert!(matches!(plan(&s1, Party::A), Some(BjMove::Stand)));
        assert!(plan(&s1, Party::B).is_none());
    }

    #[test]
    fn dealer_only_stands() {
        let mut s = initial_state(200, 200);
        s = apply_move(&s, BjMove::Bet { amount: 25 }, Party::A).unwrap();
        s = apply_move(&s, BjMove::Stand, Party::A).unwrap(); // -> dealer phase
        let dealer = dealer_party(s.round);
        assert!(matches!(plan(&s, dealer), Some(BjMove::Stand)));
        assert!(plan(&s, dealer.other()).is_none());
    }
}
