//! The Protocol seam: rules over a tunnel (Payments, Blackjack, ...). Sans-IO:
//! every method is synchronous and pure — no futures, no IO, no ambient clock/RNG.
//! Deciding a move (which may be IO-bound) is the MoveStrategy seam's job, not this one.

use crate::{Balances, ProtocolError, Seat, TunnelContext};
use serde::de::DeserializeOwned;
use serde::Serialize;

pub trait Protocol: Send + Sync + 'static {
    type State: Send + Sync;
    type Move: Send + Serialize + DeserializeOwned;

    /// Stable identifier, also the state-encoding domain tag.
    fn name(&self) -> &str;

    /// Deterministic initial state for a freshly opened tunnel.
    fn initial_state(&self, ctx: &TunnelContext) -> Self::State;

    /// Validate + apply `mv` by seat `by`. MUST be pure; MUST err on an illegal move.
    fn apply_move(
        &self,
        s: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, ProtocolError>;

    /// Canonical byte encoding hashed into the tunnel state_hash. Pure, deterministic.
    fn encode_state(&self, s: &Self::State) -> Vec<u8>;

    /// On-chain-settleable balances. MUST sum to the locked total.
    fn balances(&self, s: &Self::State) -> Balances;

    /// Whether `s` is terminal (ready to settle).
    fn is_terminal(&self, s: &Self::State) -> bool;

    /// Whether `s` is a legal cooperative close boundary for a benchmark run.
    ///
    /// Terminal states are always closeable. Protocols with legal continuation
    /// units can override this to expose episode, round, or latest-state
    /// boundaries without changing their terminal invariant.
    fn can_gracefully_close(&self, s: &Self::State) -> bool {
        self.is_terminal(s)
    }

    /// Optional: sample a legal move for `seat`, or None. Only the protocol knows its
    /// own move space, so this is what lets a generic move strategy drive any protocol.
    fn sample_move(
        &self,
        _s: &Self::State,
        _seat: Seat,
        _rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        None
    }
}
