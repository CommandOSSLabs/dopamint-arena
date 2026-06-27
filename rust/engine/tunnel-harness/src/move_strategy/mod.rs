//! The MoveStrategy seam: decides the next move. Async strategies may call an
//! LLM, oracle, or other external planner. Generic strategies delegate to
//! `Protocol::sample_move`; bespoke ones live in protocol crates.
pub mod random;

use crate::{MoveStrategyContext, Protocol, Seat};

pub trait MoveStrategy<P: Protocol>: Send + Sync + 'static {
    fn plan_move(
        &self,
        state: &P::State,
        seat: Seat,
        ctx: &MoveStrategyContext,
    ) -> impl std::future::Future<Output = Option<P::Move>> + Send;
}
