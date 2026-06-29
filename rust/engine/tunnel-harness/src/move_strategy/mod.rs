//! The MoveStrategy seam: decides the next move. Async strategies may call an
//! LLM, oracle, or other external planner. Generic strategies delegate to
//! `Protocol::sample_move`; bespoke ones live in protocol crates.
pub mod random;

use crate::{MoveStrategyContext, Protocol, Seat};

pub trait MoveStrategy<P: Protocol>: Send + Sync + 'static {
    /// Speculatively choose this seat's next move. Return `None` when the seat
    /// should wait for its peer or the protocol has no legal move for this strategy.
    fn plan_move(
        &mut self,
        state: &P::State,
        seat: Seat,
        ctx: &MoveStrategyContext,
    ) -> impl std::future::Future<Output = Option<P::Move>> + Send;

    /// Called after this strategy's proposed move is accepted by the peer and
    /// committed into the local party runtime.
    fn confirm_move(&mut self, _state: &P::State) {}

    /// Called when the driver exits with an error before normal completion.
    fn abort(&mut self) {}
}
