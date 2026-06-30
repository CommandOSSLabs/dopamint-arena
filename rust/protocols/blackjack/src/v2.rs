//! Fixed-wager Blackjack v2 with per-card two-party commit-reveal randomness.
//!
//! This is the Rust port of `sui-tunnel-ts/src/protocol/blackjack.ts`.
//! `local_secret_*` state is intentionally omitted from `encode_state`; it is
//! local runtime memory that lets the committing seat reveal later.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_core::commitment::{combine_reveals, compute_commitment, verify_commitment};
use tunnel_core::randomness::{next_u64_in_range, seed_from_bytes};
use tunnel_harness::{
    Balances, MoveStrategy, MoveStrategyContext, Protocol, ProtocolError, Seat, TunnelContext,
};

pub const WAGER: u64 = 100;
pub const ROUND_CAP: u64 = 1000;
const DEALER_STANDS_AT: u32 = 17;
const BUST_AT: u32 = 21;
const MIN_SALT_LEN: usize = 16;
const DOMAIN: &[u8] = b"sui_tunnel::proto::blackjack.v2";

pub type Party = Seat;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    DrawCommit,
    DrawReveal,
    Player,
    RoundOver,
}

impl Phase {
    fn code(self) -> u8 {
        match self {
            Phase::DrawCommit => 0,
            Phase::DrawReveal => 1,
            Phase::Player => 2,
            Phase::RoundOver => 3,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DrawHand {
    Player,
    Dealer,
}

impl DrawHand {
    fn code(self) -> u8 {
        match self {
            DrawHand::Player => 0,
            DrawHand::Dealer => 1,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DrawReason {
    Deal,
    Hit,
    DealerAuto,
}

impl DrawReason {
    fn code(self) -> u8 {
        match self {
            DrawReason::Deal => 0,
            DrawReason::Hit => 1,
            DrawReason::DealerAuto => 2,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct DrawContext {
    pub for_hand: DrawHand,
    pub reason: DrawReason,
}

#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct BlackjackV2Reveal {
    pub value: Vec<u8>,
    pub salt: Vec<u8>,
}

#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
pub struct BlackjackV2Secret {
    pub value: Vec<u8>,
    pub salt: Vec<u8>,
}

impl From<BlackjackV2Secret> for BlackjackV2Reveal {
    fn from(secret: BlackjackV2Secret) -> Self {
        Self {
            value: secret.value,
            salt: secret.salt,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlackjackV2Move {
    Deal,
    Commit {
        commitment: [u8; 32],
        #[serde(skip_serializing, skip_deserializing, default)]
        local_secret: Option<BlackjackV2Secret>,
    },
    Reveal {
        reveal: BlackjackV2Reveal,
    },
    Hit,
    Stand,
    Forfeit,
}

#[derive(Clone, Debug)]
pub struct BlackjackV2State {
    pub phase: Phase,
    pub round: u64,
    pub draw_count: u64,
    pub player_hand: Vec<u8>,
    pub dealer_hand: Vec<u8>,
    pub draw: Option<DrawContext>,
    pub pending_commit_a: Option<[u8; 32]>,
    pub pending_commit_b: Option<[u8; 32]>,
    pub pending_reveal_a: Option<BlackjackV2Reveal>,
    pub pending_reveal_b: Option<BlackjackV2Reveal>,
    pub local_secret_a: Option<BlackjackV2Secret>,
    pub local_secret_b: Option<BlackjackV2Secret>,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
    pub wager: u64,
}

pub fn compute_slot_commitment(secret: &BlackjackV2Secret) -> Result<[u8; 32], String> {
    compute_commitment(&secret.value, &secret.salt)
}

pub fn derive_rank(a: &BlackjackV2Reveal, b: &BlackjackV2Reveal) -> u8 {
    let seed = seed_from_bytes(combine_reveals(&a.value, &a.salt, &b.value, &b.salt));
    let (v, _) = next_u64_in_range(seed, 0, 13).expect("hard-coded valid rank range");
    (v as u8) + 1
}

pub fn player_party(round: u64) -> Party {
    let r = (round as i64) - 1;
    if (r.div_euclid(2)) % 2 == 0 {
        Party::A
    } else {
        Party::B
    }
}

pub fn dealer_party(round: u64) -> Party {
    player_party(round).other()
}

pub fn blackjack_hand_value(hand: &[u8]) -> u32 {
    let mut total = 0u32;
    let mut aces = 0u32;
    for &value in hand {
        total += value as u32;
        if value == 11 {
            aces += 1;
        }
    }
    while total > BUST_AT && aces > 0 {
        total -= 10;
        aces -= 1;
    }
    total
}

fn is_bust(hand: &[u8]) -> bool {
    blackjack_hand_value(hand) > BUST_AT
}

fn can_start_round(s: &BlackjackV2State) -> bool {
    s.balance_a >= s.wager && s.balance_b >= s.wager
}

fn rank_value(rank: u8) -> u8 {
    if rank == 1 {
        11
    } else if rank >= 11 {
        10
    } else {
        rank
    }
}

fn begin_draw(s: &BlackjackV2State, draw: DrawContext) -> BlackjackV2State {
    BlackjackV2State {
        phase: Phase::DrawCommit,
        draw: Some(draw),
        pending_commit_a: None,
        pending_commit_b: None,
        pending_reveal_a: None,
        pending_reveal_b: None,
        local_secret_a: None,
        local_secret_b: None,
        ..s.clone()
    }
}

fn begin_round(s: &BlackjackV2State) -> BlackjackV2State {
    let base = BlackjackV2State {
        round: s.round + 1,
        draw_count: 0,
        player_hand: Vec::new(),
        dealer_hand: Vec::new(),
        ..s.clone()
    };
    begin_draw(
        &base,
        DrawContext {
            for_hand: DrawHand::Player,
            reason: DrawReason::Deal,
        },
    )
}

fn settle(s: &BlackjackV2State, winner: Option<Party>) -> BlackjackV2State {
    let mut balance_a = s.balance_a;
    let mut balance_b = s.balance_b;
    match winner {
        Some(Party::A) => {
            let amt = s.wager.min(balance_b);
            balance_a += amt;
            balance_b -= amt;
        }
        Some(Party::B) => {
            let amt = s.wager.min(balance_a);
            balance_b += amt;
            balance_a -= amt;
        }
        None => {}
    }
    BlackjackV2State {
        phase: Phase::RoundOver,
        draw: None,
        pending_commit_a: None,
        pending_commit_b: None,
        pending_reveal_a: None,
        pending_reveal_b: None,
        local_secret_a: None,
        local_secret_b: None,
        balance_a,
        balance_b,
        ..s.clone()
    }
}

fn resolve_showdown(s: &BlackjackV2State) -> BlackjackV2State {
    let player_value = blackjack_hand_value(&s.player_hand);
    let dealer_value = blackjack_hand_value(&s.dealer_hand);
    let winner = if is_bust(&s.dealer_hand) || player_value > dealer_value {
        Some(player_party(s.round))
    } else if dealer_value > player_value {
        Some(dealer_party(s.round))
    } else {
        None
    };
    settle(s, winner)
}

fn after_draw(s: &BlackjackV2State, rank: u8) -> BlackjackV2State {
    let draw = s.draw.expect("draw exists during reveal");
    let value = rank_value(rank);
    let mut player_hand = s.player_hand.clone();
    let mut dealer_hand = s.dealer_hand.clone();
    match draw.for_hand {
        DrawHand::Player => player_hand.push(value),
        DrawHand::Dealer => dealer_hand.push(value),
    }

    let base = BlackjackV2State {
        player_hand,
        dealer_hand,
        draw_count: s.draw_count + 1,
        draw: None,
        pending_commit_a: None,
        pending_commit_b: None,
        pending_reveal_a: None,
        pending_reveal_b: None,
        local_secret_a: None,
        local_secret_b: None,
        ..s.clone()
    };

    match draw.reason {
        DrawReason::Deal => {
            if base.player_hand.len() < 2 {
                return begin_draw(
                    &base,
                    DrawContext {
                        for_hand: DrawHand::Player,
                        reason: DrawReason::Deal,
                    },
                );
            }
            if base.dealer_hand.len() < 2 {
                return begin_draw(
                    &base,
                    DrawContext {
                        for_hand: DrawHand::Dealer,
                        reason: DrawReason::Deal,
                    },
                );
            }
            BlackjackV2State {
                phase: Phase::Player,
                ..base
            }
        }
        DrawReason::Hit => {
            if is_bust(&base.player_hand) {
                settle(&base, Some(dealer_party(base.round)))
            } else {
                BlackjackV2State {
                    phase: Phase::Player,
                    ..base
                }
            }
        }
        DrawReason::DealerAuto => {
            if blackjack_hand_value(&base.dealer_hand) < DEALER_STANDS_AT {
                begin_draw(
                    &base,
                    DrawContext {
                        for_hand: DrawHand::Dealer,
                        reason: DrawReason::DealerAuto,
                    },
                )
            } else {
                resolve_showdown(&base)
            }
        }
    }
}

fn apply_commit(
    s: &BlackjackV2State,
    commitment: [u8; 32],
    local_secret: &Option<BlackjackV2Secret>,
    by: Party,
) -> Result<BlackjackV2State, String> {
    let already = match by {
        Party::A => s.pending_commit_a.is_some(),
        Party::B => s.pending_commit_b.is_some(),
    };
    if already {
        return Err(format!("party {by:?} already committed"));
    }

    let mut next = s.clone();
    match by {
        Party::A => {
            next.pending_commit_a = Some(commitment);
            next.local_secret_a = local_secret.clone();
        }
        Party::B => {
            next.pending_commit_b = Some(commitment);
            next.local_secret_b = local_secret.clone();
        }
    }
    if next.pending_commit_a.is_some() && next.pending_commit_b.is_some() {
        next.phase = Phase::DrawReveal;
    }
    Ok(next)
}

fn apply_reveal(
    s: &BlackjackV2State,
    reveal: &BlackjackV2Reveal,
    by: Party,
) -> Result<BlackjackV2State, String> {
    let already = match by {
        Party::A => s.pending_reveal_a.is_some(),
        Party::B => s.pending_reveal_b.is_some(),
    };
    if already {
        return Err(format!("party {by:?} already revealed"));
    }
    let commit = match by {
        Party::A => s.pending_commit_a,
        Party::B => s.pending_commit_b,
    }
    .ok_or_else(|| format!("party {by:?} has no commitment to reveal"))?;
    if !verify_commitment(&commit, &reveal.value, &reveal.salt) {
        return Err(format!("reveal does not match commitment for party {by:?}"));
    }

    let mut next = s.clone();
    match by {
        Party::A => next.pending_reveal_a = Some(reveal.clone()),
        Party::B => next.pending_reveal_b = Some(reveal.clone()),
    }
    if let (Some(a), Some(b)) = (&next.pending_reveal_a, &next.pending_reveal_b) {
        return Ok(after_draw(&next, derive_rank(a, b)));
    }
    Ok(next)
}

fn claim_forfeit(s: &BlackjackV2State, by: Party) -> Result<BlackjackV2State, String> {
    let opponent = by.other();
    match s.phase {
        Phase::DrawCommit => {
            let mine = if by == Party::A {
                s.pending_commit_a
            } else {
                s.pending_commit_b
            };
            let theirs = if opponent == Party::A {
                s.pending_commit_a
            } else {
                s.pending_commit_b
            };
            if mine.is_none() || theirs.is_some() {
                return Err("forfeit not claimable: opponent does not owe a commit".into());
            }
        }
        Phase::DrawReveal => {
            let mine = if by == Party::A {
                s.pending_reveal_a.as_ref()
            } else {
                s.pending_reveal_b.as_ref()
            };
            let theirs = if opponent == Party::A {
                s.pending_reveal_a.as_ref()
            } else {
                s.pending_reveal_b.as_ref()
            };
            if mine.is_none() || theirs.is_some() {
                return Err("forfeit not claimable: opponent does not owe a reveal".into());
            }
        }
        _ => return Err("forfeit only valid during a pending draw".into()),
    }
    Ok(settle(s, Some(by)))
}

pub fn initial_state(balance_a: u64, balance_b: u64) -> BlackjackV2State {
    let base = BlackjackV2State {
        phase: Phase::RoundOver,
        round: 0,
        draw_count: 0,
        player_hand: Vec::new(),
        dealer_hand: Vec::new(),
        draw: None,
        pending_commit_a: None,
        pending_commit_b: None,
        pending_reveal_a: None,
        pending_reveal_b: None,
        local_secret_a: None,
        local_secret_b: None,
        balance_a,
        balance_b,
        total: balance_a + balance_b,
        wager: WAGER,
    };
    if can_start_round(&base) {
        begin_round(&base)
    } else {
        base
    }
}

pub fn is_terminal(s: &BlackjackV2State) -> bool {
    s.round >= ROUND_CAP || (s.phase == Phase::RoundOver && !can_start_round(s))
}

pub fn apply_move(
    s: &BlackjackV2State,
    mv: &BlackjackV2Move,
    by: Party,
) -> Result<BlackjackV2State, String> {
    match s.phase {
        Phase::RoundOver => {
            if !matches!(mv, BlackjackV2Move::Deal) {
                return Err("expected 'deal' in round_over".into());
            }
            if is_terminal(s) {
                return Err("game over: no more rounds can be played".into());
            }
            Ok(begin_round(s))
        }
        Phase::DrawCommit => match mv {
            BlackjackV2Move::Forfeit => claim_forfeit(s, by),
            BlackjackV2Move::Commit {
                commitment,
                local_secret,
            } => apply_commit(s, *commitment, local_secret, by),
            _ => Err("expected 'commit' in draw_commit".into()),
        },
        Phase::DrawReveal => match mv {
            BlackjackV2Move::Forfeit => claim_forfeit(s, by),
            BlackjackV2Move::Reveal { reveal } => apply_reveal(s, reveal, by),
            _ => Err("expected 'reveal' in draw_reveal".into()),
        },
        Phase::Player => {
            let player = player_party(s.round);
            if by != player {
                return Err(format!("it is the player's ({player:?}) turn"));
            }
            match mv {
                BlackjackV2Move::Hit => Ok(begin_draw(
                    s,
                    DrawContext {
                        for_hand: DrawHand::Player,
                        reason: DrawReason::Hit,
                    },
                )),
                BlackjackV2Move::Stand => {
                    if blackjack_hand_value(&s.dealer_hand) >= DEALER_STANDS_AT {
                        Ok(resolve_showdown(s))
                    } else {
                        Ok(begin_draw(
                            s,
                            DrawContext {
                                for_hand: DrawHand::Dealer,
                                reason: DrawReason::DealerAuto,
                            },
                        ))
                    }
                }
                _ => Err("expected 'hit' or 'stand' in player phase".into()),
            }
        }
    }
}

fn push_length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u64_to_be_bytes(bytes.len() as u64));
    out.extend_from_slice(bytes);
}

pub fn encode_state(s: &BlackjackV2State) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(DOMAIN);
    out.extend_from_slice(&u64_to_be_bytes(s.balance_a));
    out.extend_from_slice(&u64_to_be_bytes(s.balance_b));
    out.extend_from_slice(&u64_to_be_bytes(s.round));
    out.extend_from_slice(&u64_to_be_bytes(s.draw_count));
    out.push(s.phase.code());
    out.extend_from_slice(&u64_to_be_bytes(s.player_hand.len() as u64));
    out.extend_from_slice(&s.player_hand);
    out.extend_from_slice(&u64_to_be_bytes(s.dealer_hand.len() as u64));
    out.extend_from_slice(&s.dealer_hand);
    if let Some(draw) = s.draw {
        out.push(1);
        out.push(draw.for_hand.code());
        out.push(draw.reason.code());
    } else {
        out.push(0xff);
    }
    push_length_prefixed(
        &mut out,
        s.pending_commit_a.as_ref().map_or(&[], |c| &c[..]),
    );
    push_length_prefixed(
        &mut out,
        s.pending_commit_b.as_ref().map_or(&[], |c| &c[..]),
    );
    for reveal in [&s.pending_reveal_a, &s.pending_reveal_b] {
        if let Some(reveal) = reveal {
            out.push(1);
            push_length_prefixed(&mut out, &reveal.value);
            push_length_prefixed(&mut out, &reveal.salt);
        } else {
            out.push(0);
        }
    }
    out
}

fn random_secret(rng: &mut dyn FnMut() -> f64) -> BlackjackV2Secret {
    let mut next_byte = || (rng() * 256.0).floor() as u8;
    let value = vec![next_byte()];
    let salt = (0..MIN_SALT_LEN).map(|_| next_byte()).collect();
    BlackjackV2Secret { value, salt }
}

#[derive(Clone, Copy, Debug)]
pub struct BlackjackV2Strategy {
    rng_state: u32,
}

impl BlackjackV2Strategy {
    pub fn new(seed: u64) -> Self {
        Self {
            rng_state: seed as u32,
        }
    }

    fn next_f64(&mut self) -> f64 {
        self.rng_state = self.rng_state.wrapping_add(0x6d2b_79f5);
        let mut t = (self.rng_state ^ (self.rng_state >> 15)).wrapping_mul(1 | self.rng_state);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

fn draw_commit_actor(state: &BlackjackV2State) -> Option<Seat> {
    if state.pending_commit_a.is_none() {
        Some(Seat::A)
    } else if state.pending_commit_b.is_none() {
        Some(Seat::B)
    } else {
        None
    }
}

fn draw_reveal_actor(state: &BlackjackV2State) -> Option<Seat> {
    if state.pending_reveal_a.is_none() {
        Some(Seat::A)
    } else if state.pending_reveal_b.is_none() {
        Some(Seat::B)
    } else {
        None
    }
}

impl MoveStrategy<BlackjackV2> for BlackjackV2Strategy {
    async fn plan_move(
        &mut self,
        state: &BlackjackV2State,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<BlackjackV2Move> {
        if is_terminal(state) {
            return None;
        }
        match state.phase {
            Phase::RoundOver => {
                (seat == player_party(state.round + 1)).then_some(BlackjackV2Move::Deal)
            }
            Phase::DrawCommit => {
                if draw_commit_actor(state) != Some(seat) {
                    return None;
                }
                let mut rng = || self.next_f64();
                let secret = random_secret(&mut rng);
                Some(BlackjackV2Move::Commit {
                    commitment: compute_slot_commitment(&secret).ok()?,
                    local_secret: Some(secret),
                })
            }
            Phase::DrawReveal => {
                if draw_reveal_actor(state) != Some(seat) {
                    return None;
                }
                let secret = if seat == Seat::A {
                    state.local_secret_a.clone()
                } else {
                    state.local_secret_b.clone()
                }?;
                Some(BlackjackV2Move::Reveal {
                    reveal: secret.into(),
                })
            }
            Phase::Player => {
                if seat != player_party(state.round) {
                    return None;
                }
                Some(
                    if blackjack_hand_value(&state.player_hand) < DEALER_STANDS_AT {
                        BlackjackV2Move::Hit
                    } else {
                        BlackjackV2Move::Stand
                    },
                )
            }
        }
    }
}

#[derive(Clone, Copy)]
pub struct BlackjackV2;

impl Protocol for BlackjackV2 {
    type State = BlackjackV2State;
    type Move = BlackjackV2Move;

    fn name(&self) -> &str {
        "blackjack.v2"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        initial_state(ctx.initial.a, ctx.initial.b)
    }

    fn apply_move(
        &self,
        s: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, ProtocolError> {
        apply_move(s, mv, by).map_err(ProtocolError)
    }

    fn encode_state(&self, s: &Self::State) -> Vec<u8> {
        encode_state(s)
    }

    fn balances(&self, s: &Self::State) -> Balances {
        Balances {
            a: s.balance_a,
            b: s.balance_b,
        }
    }

    fn is_terminal(&self, s: &Self::State) -> bool {
        is_terminal(s)
    }

    fn sample_move(
        &self,
        s: &Self::State,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        if is_terminal(s) {
            return None;
        }
        match s.phase {
            Phase::RoundOver => {
                if seat == player_party(s.round + 1) {
                    Some(BlackjackV2Move::Deal)
                } else {
                    None
                }
            }
            Phase::DrawCommit => {
                let mine = if seat == Seat::A {
                    s.pending_commit_a
                } else {
                    s.pending_commit_b
                };
                if mine.is_some() {
                    return None;
                }
                let secret = random_secret(rng);
                Some(BlackjackV2Move::Commit {
                    commitment: compute_slot_commitment(&secret).ok()?,
                    local_secret: Some(secret),
                })
            }
            Phase::DrawReveal => {
                let mine = if seat == Seat::A {
                    s.pending_reveal_a.as_ref()
                } else {
                    s.pending_reveal_b.as_ref()
                };
                if mine.is_some() {
                    return None;
                }
                let secret = if seat == Seat::A {
                    s.local_secret_a.clone()
                } else {
                    s.local_secret_b.clone()
                }?;
                Some(BlackjackV2Move::Reveal {
                    reveal: secret.into(),
                })
            }
            Phase::Player => {
                if seat != player_party(s.round) {
                    return None;
                }
                Some(if blackjack_hand_value(&s.player_hand) < DEALER_STANDS_AT {
                    BlackjackV2Move::Hit
                } else {
                    BlackjackV2Move::Stand
                })
            }
        }
    }
}

#[cfg(test)]
mod strategy_tests {
    use super::*;
    use tunnel_harness::{
        Balances, InMemoryAnchor, InMemoryFrameTransport, LocalSigner, MoveStrategy,
        MoveStrategyContext, NullTranscriptRecorder, PartyDriver, SeatParts, Signer,
    };

    fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
        MoveStrategyContext {
            tunnel_id: "0xb1".into(),
            seat,
        }
    }

    fn secret(byte: u8) -> BlackjackV2Secret {
        BlackjackV2Secret {
            value: vec![byte; 16],
            salt: vec![byte.wrapping_add(1); 16],
        }
    }

    fn commit_from_secret(secret: BlackjackV2Secret) -> BlackjackV2Move {
        BlackjackV2Move::Commit {
            commitment: compute_slot_commitment(&secret).unwrap(),
            local_secret: Some(secret),
        }
    }

    #[tokio::test]
    async fn draw_commit_strategy_serializes_a_before_b_while_protocol_allows_either_missing_seat()
    {
        let protocol = BlackjackV2;
        let state = initial_state(500, 500);
        assert_eq!(state.phase, Phase::DrawCommit);
        let mut a = BlackjackV2Strategy::new(1);
        let mut b = BlackjackV2Strategy::new(2);

        let commit_a = a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("A should commit while its slot is missing");
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());

        let state = protocol.apply_move(&state, &commit_a, Seat::A).unwrap();
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_some());
        let state = protocol
            .apply_move(
                &initial_state(500, 500),
                &commit_from_secret(secret(7)),
                Seat::B,
            )
            .unwrap();
        assert!(a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .is_some());
    }

    #[tokio::test]
    async fn draw_reveal_strategy_serializes_a_before_b_while_protocol_allows_either_missing_seat()
    {
        let protocol = BlackjackV2;
        let mut state = initial_state(500, 500);
        let mut a = BlackjackV2Strategy::new(1);
        let mut b = BlackjackV2Strategy::new(2);

        let secret_b = secret(9);
        state = protocol
            .apply_move(&state, &commit_from_secret(secret_b.clone()), Seat::B)
            .unwrap();
        let commit_a = a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .unwrap();
        state = protocol.apply_move(&state, &commit_a, Seat::A).unwrap();
        assert_eq!(state.phase, Phase::DrawReveal);

        let reveal_a = a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("A should reveal while its slot is missing");
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());

        let state_before_reveal = state.clone();
        state = protocol.apply_move(&state, &reveal_a, Seat::A).unwrap();
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_some());
        let state = protocol
            .apply_move(
                &state_before_reveal,
                &BlackjackV2Move::Reveal {
                    reveal: secret_b.into(),
                },
                Seat::B,
            )
            .unwrap();
        assert!(a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .is_some());
    }

    fn parts(
        seat: Seat,
        signer: LocalSigner,
        opponent_pk: [u8; 32],
    ) -> SeatParts<BlackjackV2, LocalSigner> {
        SeatParts {
            protocol: BlackjackV2,
            signer,
            opponent_pk,
            initial: Balances { a: 500, b: 500 },
            seat,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn party_driver_self_play_does_not_cross_propose_in_commit_reveal() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let signer_a = LocalSigner::from_secret(&secret_a);
        let signer_b = LocalSigner::from_secret(&secret_b);
        let pk_a = signer_a.public_key();
        let pk_b = signer_b.public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();

        let anchor = InMemoryAnchor::with_fixed_id("0xb1");
        let driver_a = PartyDriver::new(
            parts(Seat::A, signer_a, pk_b),
            BlackjackV2Strategy::new(1),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, signer_b, pk_a),
            BlackjackV2Strategy::new(2),
            ch_b,
            anchor.clone(),
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(1000, || 1), driver_b.run(1000, || 1));
        let out_a = out_a.unwrap().0;
        let out_b = out_b.unwrap().0;

        assert_eq!(out_a.final_balances.sum(), 1000);
        assert_eq!(out_a.final_balances, out_b.final_balances);
        assert!(out_a.moves > 0);
    }

    #[test]
    fn strategy_rng_matches_ts_mulberry32_stream() {
        let mut strategy = BlackjackV2Strategy::new(1);
        assert_close(strategy.next_f64(), 0.627_073_940_588_161_3);
        assert_close(strategy.next_f64(), 0.002_735_721_180_215_478);
        assert_close(strategy.next_f64(), 0.527_447_039_959_952_2);
    }

    #[tokio::test]
    async fn player_phase_only_player_hits_below_seventeen_and_stands_at_seventeen() {
        let mut low = initial_state(500, 500);
        low.phase = Phase::Player;
        low.round = 1;
        low.player_hand = vec![10, 6];
        let mut made = low.clone();
        made.player_hand = vec![10, 7];
        let mut a = BlackjackV2Strategy::new(1);
        let mut b = BlackjackV2Strategy::new(2);

        assert!(matches!(
            a.plan_move(&low, Seat::A, &strategy_ctx(Seat::A)).await,
            Some(BlackjackV2Move::Hit)
        ));
        assert!(b
            .plan_move(&low, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());
        assert!(matches!(
            a.plan_move(&made, Seat::A, &strategy_ctx(Seat::A)).await,
            Some(BlackjackV2Move::Stand)
        ));
    }

    #[tokio::test]
    async fn round_over_next_player_deals() {
        let mut state = initial_state(500, 500);
        state.phase = Phase::RoundOver;
        let mut a = BlackjackV2Strategy::new(1);
        let mut b = BlackjackV2Strategy::new(2);

        assert!(matches!(
            a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await,
            Some(BlackjackV2Move::Deal)
        ));
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn short_self_play_conserves_balances() {
        let protocol = BlackjackV2;
        let mut state = initial_state(500, 500);
        let mut a = BlackjackV2Strategy::new(1);
        let mut b = BlackjackV2Strategy::new(2);

        for _ in 0..200 {
            if protocol.is_terminal(&state) || state.round >= 3 {
                break;
            }
            let planned_a = a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await;
            let planned_b = b.plan_move(&state, Seat::B, &strategy_ctx(Seat::B)).await;
            let (seat, mv) = match (planned_a, planned_b) {
                (Some(mv), _) => (Seat::A, mv),
                (None, Some(mv)) => (Seat::B, mv),
                (None, None) => panic!("expected at least one planned move"),
            };
            state = protocol.apply_move(&state, &mv, seat).unwrap();
            assert_eq!(protocol.balances(&state).sum(), 1000);
        }

        assert!(state.round >= 1);
        assert_eq!(protocol.balances(&state).sum(), 1000);
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < f64::EPSILON,
            "expected {expected}, got {actual}"
        );
    }
}
