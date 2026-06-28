use crate::duel::{BlackjackDuel, DuelMove, DuelState};
use crate::{plan, BjMove, BjState, Blackjack};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Protocol, Seat};

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
        if state.phase == crate::duel::DuelPhase::Over {
            return None;
        }
        BlackjackDuel.sample_move(state, seat, &mut || 0.0)
    }
}
