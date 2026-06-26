//! A generic random policy: works for ANY protocol that implements `sample_move`.
//! Uses a deterministic splitmix64-seeded rng so self-play runs reproduce.

use super::Policy;
use crate::{PolicyContext, Protocol, Seat};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub struct RandomPolicy<P: Protocol> {
    protocol: Arc<P>,
    state: AtomicU64,
}

impl<P: Protocol> RandomPolicy<P> {
    pub fn new(protocol: Arc<P>, seed: u64) -> RandomPolicy<P> {
        RandomPolicy {
            protocol,
            state: AtomicU64::new(seed),
        }
    }

    fn next_f64(&self) -> f64 {
        let mut z = self
            .state
            .fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
        z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    }
}

impl<P: Protocol> Policy<P> for RandomPolicy<P> {
    async fn plan_move(
        &self,
        state: &P::State,
        seat: Seat,
        _ctx: &PolicyContext,
    ) -> Option<P::Move> {
        let mut rng = || self.next_f64();
        self.protocol.sample_move(state, seat, &mut rng)
    }
}
