//! Blackjack duel protocol, ported from the game-side TS implementation.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_core::crypto::blake2b256;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

use crate::hand_value;

pub const STAKE: u64 = 10_000_000;
const DEALER_STANDS_AT: u32 = 17;
const BUST_AT: u32 = 21;
const DOMAIN: &[u8] = b"sui_tunnel::proto::blackjack.duel.v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DuelPhase {
    ATurn,
    BTurn,
    Over,
}

impl DuelPhase {
    fn code(self) -> u8 {
        match self {
            DuelPhase::ATurn => 0,
            DuelPhase::BTurn => 1,
            DuelPhase::Over => 2,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DuelState {
    pub seed: [u8; 32],
    pub dealer_hand: Vec<u8>,
    pub hand_a: Vec<u8>,
    pub hand_b: Vec<u8>,
    pub phase: DuelPhase,
    pub draw_index: u64,
    pub balance_a: u64,
    pub balance_b: u64,
    pub wager: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DuelAction {
    Hit,
    Stand,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DuelMove {
    pub action: DuelAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DuelOutcome {
    A,
    B,
    Push,
}

pub struct BlackjackDuel;

fn draw_rank(seed: &[u8; 32], draw_index: u64) -> u8 {
    let mut digest = *seed;
    let block = draw_index / 32;
    for b in 0..block {
        let mut input = Vec::with_capacity(40);
        input.extend_from_slice(&digest);
        input.extend_from_slice(&u64_to_be_bytes(b));
        digest = blake2b256(&input);
    }
    (digest[(draw_index % 32) as usize] % 13) + 1
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

fn is_bust(hand: &[u8]) -> bool {
    hand_value(hand) > BUST_AT
}

fn draw_to(hand: &mut Vec<u8>, seed: &[u8; 32], draw_index: &mut u64) {
    hand.push(rank_value(draw_rank(seed, *draw_index)));
    *draw_index += 1;
}

pub fn settle_outcome(hand_a: &[u8], hand_b: &[u8], dealer_hand: &[u8]) -> DuelOutcome {
    let dealer_value = hand_value(dealer_hand);
    let dealer_bust = dealer_value > BUST_AT;
    let rank = |hand: &[u8]| {
        if is_bust(hand) {
            return (0u8, 0u32);
        }
        let value = hand_value(hand);
        let result = if dealer_bust || value > dealer_value {
            2
        } else if value < dealer_value {
            0
        } else {
            1
        };
        (result, value)
    };
    let a = rank(hand_a);
    let b = rank(hand_b);
    if a.0 != b.0 {
        return if a.0 > b.0 {
            DuelOutcome::A
        } else {
            DuelOutcome::B
        };
    }
    if a.1 != b.1 {
        return if a.1 > b.1 {
            DuelOutcome::A
        } else {
            DuelOutcome::B
        };
    }
    DuelOutcome::Push
}

fn resolve_and_settle(state: &DuelState) -> DuelState {
    let mut dealer_hand = state.dealer_hand.clone();
    let mut draw_index = state.draw_index;
    while hand_value(&dealer_hand) < DEALER_STANDS_AT {
        draw_to(&mut dealer_hand, &state.seed, &mut draw_index);
    }
    let outcome = settle_outcome(&state.hand_a, &state.hand_b, &dealer_hand);
    let mut balance_a = state.balance_a;
    let mut balance_b = state.balance_b;
    match outcome {
        DuelOutcome::A => {
            let amount = state.wager.min(balance_b);
            balance_a += amount;
            balance_b -= amount;
        }
        DuelOutcome::B => {
            let amount = state.wager.min(balance_a);
            balance_b += amount;
            balance_a -= amount;
        }
        DuelOutcome::Push => {}
    }
    DuelState {
        dealer_hand,
        draw_index,
        phase: DuelPhase::Over,
        balance_a,
        balance_b,
        ..state.clone()
    }
}

impl Protocol for BlackjackDuel {
    type State = DuelState;
    type Move = DuelMove;

    fn name(&self) -> &str {
        "blackjack.duel.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        let mut seed_input = Vec::with_capacity(DOMAIN.len() + ctx.tunnel_id.len());
        seed_input.extend_from_slice(DOMAIN);
        seed_input.extend_from_slice(ctx.tunnel_id.as_bytes());
        let seed = blake2b256(&seed_input);
        let mut draw_index = 0;
        let mut dealer_hand = Vec::new();
        let mut hand_a = Vec::new();
        let mut hand_b = Vec::new();
        for _ in 0..2 {
            draw_to(&mut dealer_hand, &seed, &mut draw_index);
        }
        for _ in 0..2 {
            draw_to(&mut hand_a, &seed, &mut draw_index);
        }
        for _ in 0..2 {
            draw_to(&mut hand_b, &seed, &mut draw_index);
        }
        DuelState {
            seed,
            dealer_hand,
            hand_a,
            hand_b,
            phase: DuelPhase::ATurn,
            draw_index,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            wager: STAKE,
        }
    }

    fn apply_move(
        &self,
        state: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, ProtocolError> {
        if state.phase == DuelPhase::Over {
            return Err(ProtocolError("duel is over".into()));
        }
        let seat = if state.phase == DuelPhase::ATurn {
            Seat::A
        } else {
            Seat::B
        };
        if by != seat {
            return Err(ProtocolError(format!("it is {seat:?}'s turn")));
        }

        let mut next = state.clone();
        let hand = if seat == Seat::A {
            &mut next.hand_a
        } else {
            &mut next.hand_b
        };
        let turn_ended = match mv.action {
            DuelAction::Hit => {
                draw_to(hand, &next.seed, &mut next.draw_index);
                is_bust(hand)
            }
            DuelAction::Stand => true,
        };
        if !turn_ended {
            return Ok(next);
        }
        if seat == Seat::A {
            next.phase = DuelPhase::BTurn;
            Ok(next)
        } else {
            Ok(resolve_and_settle(&next))
        }
    }

    fn encode_state(&self, state: &Self::State) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&u64_to_be_bytes(state.seed.len() as u64));
        out.extend_from_slice(&state.seed);
        out.extend_from_slice(&u64_to_be_bytes(state.dealer_hand.len() as u64));
        out.extend_from_slice(&state.dealer_hand);
        out.extend_from_slice(&u64_to_be_bytes(state.hand_a.len() as u64));
        out.extend_from_slice(&state.hand_a);
        out.extend_from_slice(&u64_to_be_bytes(state.hand_b.len() as u64));
        out.extend_from_slice(&state.hand_b);
        out.push(state.phase.code());
        out.extend_from_slice(&u64_to_be_bytes(state.draw_index));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_a));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_b));
        out.extend_from_slice(&u64_to_be_bytes(state.wager));
        out
    }

    fn balances(&self, state: &Self::State) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &Self::State) -> bool {
        state.phase == DuelPhase::Over
    }

    fn sample_move(
        &self,
        state: &Self::State,
        seat: Seat,
        _rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        let active = match state.phase {
            DuelPhase::ATurn => Seat::A,
            DuelPhase::BTurn => Seat::B,
            DuelPhase::Over => return None,
        };
        if seat != active {
            return None;
        }
        let hand = if seat == Seat::A {
            &state.hand_a
        } else {
            &state.hand_b
        };
        Some(DuelMove {
            action: if hand_value(hand) < DEALER_STANDS_AT {
                DuelAction::Hit
            } else {
                DuelAction::Stand
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "0xduel".into(),
            initial: Balances {
                a: 20_000_000,
                b: 20_000_000,
            },
            seat: Seat::A,
        }
    }

    #[test]
    fn initial_state_deals_shared_dealer_and_two_hands() {
        let protocol = BlackjackDuel;
        let state = protocol.initial_state(&ctx());
        assert_eq!(protocol.name(), "blackjack.duel.v1");
        assert_eq!(state.phase, DuelPhase::ATurn);
        assert_eq!(state.dealer_hand.len(), 2);
        assert_eq!(state.hand_a.len(), 2);
        assert_eq!(state.hand_b.len(), 2);
        assert_eq!(state.draw_index, 6);
        assert!(protocol
            .encode_state(&state)
            .starts_with(b"sui_tunnel::proto::blackjack.duel.v1"));
    }

    #[test]
    fn stand_stand_reaches_terminal_and_conserves_balances() {
        let protocol = BlackjackDuel;
        let mut state = protocol.initial_state(&ctx());
        state = protocol
            .apply_move(
                &state,
                &DuelMove {
                    action: DuelAction::Stand,
                },
                Seat::A,
            )
            .unwrap();
        assert_eq!(state.phase, DuelPhase::BTurn);
        state = protocol
            .apply_move(
                &state,
                &DuelMove {
                    action: DuelAction::Stand,
                },
                Seat::B,
            )
            .unwrap();
        assert_eq!(state.phase, DuelPhase::Over);
        assert_eq!(protocol.balances(&state).sum(), 40_000_000);
    }
}
