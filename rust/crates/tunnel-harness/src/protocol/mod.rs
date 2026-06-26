//! The Protocol seam: rules over a tunnel (Payments, Blackjack, ...). Async where
//! flexibility helps; the three settlement-critical methods stay sync + pure.

use crate::{Balances, ProtocolError, Seat, TunnelContext};
use serde::{de::DeserializeOwned, Serialize};

pub trait Protocol: Send + Sync + 'static {
    type State: Send + Sync;
    type Move: Send + Serialize + DeserializeOwned;

    /// Stable identifier, also the state-encoding domain tag.
    fn name(&self) -> &str;

    /// Deterministic initial state for a freshly opened tunnel.
    fn initial_state(
        &self,
        ctx: &TunnelContext,
    ) -> impl std::future::Future<Output = Self::State> + Send;

    /// Validate + apply `mv` by seat `by`. MUST be pure; MUST err on an illegal move.
    fn apply_move(
        &self,
        s: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> impl std::future::Future<Output = Result<Self::State, ProtocolError>> + Send;

    /// Canonical byte encoding hashed into the tunnel state_hash. Pure, deterministic.
    fn encode_state(&self, s: &Self::State) -> Vec<u8>;

    /// On-chain-settleable balances. MUST sum to the locked total.
    fn balances(&self, s: &Self::State) -> Balances;

    /// Whether `s` is terminal (ready to settle).
    fn is_terminal(&self, s: &Self::State) -> bool;

    /// Optional: sample a legal move for `seat`, or None. Only the protocol knows its
    /// own move space, so this is what lets a generic policy drive any protocol.
    fn sample_move(
        &self,
        _s: &Self::State,
        _seat: Seat,
        _rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        None
    }
}
