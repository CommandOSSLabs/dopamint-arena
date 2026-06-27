//! The Policy seam: decides the next move. Async (may call an LLM/oracle). Generic
//! policies delegate to Protocol::sample_move; bespoke ones live in protocol crates.
pub mod random;

use tunnel_harness::{PolicyContext, Protocol, Seat};

pub trait Policy<P: Protocol>: Send + Sync + 'static {
    fn plan_move(
        &self,
        state: &P::State,
        seat: Seat,
        ctx: &PolicyContext,
    ) -> impl std::future::Future<Output = Option<P::Move>> + Send;
}
