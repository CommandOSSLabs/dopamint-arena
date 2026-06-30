use crate::{Chat, ChatMove, ChatState};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Seat};

#[derive(Clone, Copy, Debug)]
pub struct ChatStrategy {
    rng_state: u64,
}

impl ChatStrategy {
    pub fn new(seed: u64) -> Self {
        Self { rng_state: seed }
    }

    fn next_f64(&mut self) -> f64 {
        self.rng_state = splitmix_next(self.rng_state);
        (self.rng_state >> 11) as f64 / (1u64 << 53) as f64
    }
}

impl MoveStrategy<Chat> for ChatStrategy {
    async fn plan_move(
        &mut self,
        state: &ChatState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<ChatMove> {
        let text = format!("msg{}", state.message_count);
        let balance = match seat {
            Seat::A => state.balance_a,
            Seat::B => state.balance_b,
        };
        if balance > 0 && self.next_f64() < 0.25 {
            let cap = balance.min(10);
            let tip = 1 + (self.next_f64() * cap as f64).floor() as u64;
            return Some(ChatMove {
                text,
                tip: Some(tip),
            });
        }
        Some(ChatMove { text, tip: None })
    }
}

fn splitmix_next(state: u64) -> u64 {
    let mut z = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}
