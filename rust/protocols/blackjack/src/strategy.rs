use crate::duel::{BlackjackDuel, DuelAction, DuelMove, DuelPhase, DuelState};
use crate::{hand_value, plan, BjMove, BjState, Blackjack};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Seat};

const DEALER_STANDS_AT: u32 = 17;

#[derive(Clone, Copy, Debug, Default)]
pub struct BlackjackStrategy;

impl MoveStrategy<Blackjack> for BlackjackStrategy {
    async fn plan_move(
        &mut self,
        state: &BjState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<BjMove> {
        plan(state, seat)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct BlackjackDuelStrategy;

impl MoveStrategy<BlackjackDuel> for BlackjackDuelStrategy {
    async fn plan_move(
        &mut self,
        state: &DuelState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<DuelMove> {
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
