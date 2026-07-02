//! Protocol selection and a deterministic, seeded move strategy.
//!
//! Runs must be reproducible: a fixed seed yields a constant move sequence per
//! tunnel (golden), or a per-tunnel-varied sequence keyed on the local index.
//! We do not reproduce `fleet-bench`'s exact numbers — only our own internal
//! determinism. Both supported protocols expose a self-contained
//! `Protocol::sample_move` (blackjack.v2 carries its commit/reveal secrets in
//! the tunnel state, so a stateless RNG is sufficient), which lets one
//! `SeededStrategy` drive either protocol.

use tunnel_blackjack::v2::BlackjackV2;
use tunnel_core::protocol_id::{BLACKJACK_V2, PAYMENTS_V1};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Protocol, Seat};
use tunnel_payments::Payments;

/// Which protocol a swarm drives over its tunnels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolKind {
    BlackjackV2,
    Payments,
}

impl ProtocolKind {
    /// Parse a canonical protocol id (e.g. `"blackjack.v2"`).
    pub fn from_id(s: &str) -> Result<ProtocolKind, String> {
        if s == BLACKJACK_V2 {
            Ok(ProtocolKind::BlackjackV2)
        } else if s == PAYMENTS_V1 {
            Ok(ProtocolKind::Payments)
        } else {
            Err(format!("unsupported protocol id: {s}"))
        }
    }

    /// The canonical protocol id string for this kind.
    pub fn id(&self) -> &'static str {
        match self {
            ProtocolKind::BlackjackV2 => BLACKJACK_V2,
            ProtocolKind::Payments => PAYMENTS_V1,
        }
    }
}

/// Selects the seed regime for gameplay.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    /// Every tunnel plays the identical, fixed sequence (golden determinism).
    Golden,
    /// Each tunnel varies by its local index.
    Varied,
}

/// Golden seed is a fixed constant so per-tunnel move totals never change;
/// varied seeds are the local index so tunnels diverge deterministically.
pub fn play_seed(scenario: Scenario, local_index: u64) -> u64 {
    match scenario {
        Scenario::Golden => 0x9E37_79B9_7F4A_7C15,
        Scenario::Varied => local_index,
    }
}

/// A deterministic `MoveStrategy` seeded from a single `u64`. Uses xorshift64*
/// to feed the protocol's own `sample_move`, so the move sequence is a pure
/// function of the seed and the tunnel state.
pub struct SeededStrategy {
    rng_state: u64,
}

impl SeededStrategy {
    pub fn new(seed: u64) -> Self {
        // xorshift64* must never sit at zero, or it stays stuck there.
        Self { rng_state: seed | 1 }
    }

    fn next_f64(&mut self) -> f64 {
        let mut x = self.rng_state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng_state = x;
        ((x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

impl MoveStrategy<Payments> for SeededStrategy {
    async fn plan_move(
        &mut self,
        state: &<Payments as Protocol>::State,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<<Payments as Protocol>::Move> {
        // `max_transfers` only shapes the initial state; `sample_move` reads the
        // cap off the tunnel state, so any instance samples identically.
        let protocol = Payments { max_transfers: 0 };
        let mut rng = || self.next_f64();
        protocol.sample_move(state, seat, &mut rng)
    }
}

impl MoveStrategy<BlackjackV2> for SeededStrategy {
    async fn plan_move(
        &mut self,
        state: &<BlackjackV2 as Protocol>::State,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<<BlackjackV2 as Protocol>::Move> {
        let mut rng = || self.next_f64();
        BlackjackV2.sample_move(state, seat, &mut rng)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn golden_seed_is_constant_varied_is_indexed() {
        assert_eq!(play_seed(Scenario::Golden, 0), play_seed(Scenario::Golden, 9));
        assert_ne!(play_seed(Scenario::Varied, 0), play_seed(Scenario::Varied, 1));
    }
    #[test]
    fn protocol_from_id_roundtrip() {
        assert_eq!(ProtocolKind::from_id("blackjack.v2").unwrap().id(), "blackjack.v2");
        assert!(ProtocolKind::from_id("nope").is_err());
    }
}
