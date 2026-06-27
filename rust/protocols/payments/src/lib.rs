//! Payments as a tunnel Protocol: the signing seat transfers value to the other
//! seat. This ports the canonical TS `payments.v1` move shape; `max_transfers`
//! is only a harness cap for bounded self-play tests.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

const DOMAIN: &[u8] = b"sui_tunnel::proto::payments.v1";
const TRANSFER: u64 = 1;

#[derive(Clone, Debug)]
pub struct PayState {
    pub a: u64,
    pub b: u64,
    pub total: u64,
    pub count: u64,
    pub max_transfers: u64,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct PayMove {
    pub from: Seat,
    pub amount: u64,
}

pub struct Payments {
    /// `0` means unbounded, matching TS `isTerminal() === false`.
    pub max_transfers: u64,
}

impl Protocol for Payments {
    type State = PayState;
    type Move = PayMove;

    fn name(&self) -> &str {
        "payments.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> PayState {
        PayState {
            a: ctx.initial.a,
            b: ctx.initial.b,
            total: ctx.initial.a + ctx.initial.b,
            count: 0,
            max_transfers: self.max_transfers,
        }
    }

    fn apply_move(&self, s: &PayState, mv: &PayMove, by: Seat) -> Result<PayState, ProtocolError> {
        if mv.from != by {
            return Err(ProtocolError(format!(
                "move.from ({:?}) must equal signer ({by:?})",
                mv.from
            )));
        }
        if mv.amount == 0 {
            return Err(ProtocolError("payment amount must be positive".into()));
        }
        let mut next = s.clone();
        match mv.from {
            Seat::A => {
                if mv.amount > next.a {
                    return Err(ProtocolError("insufficient balance".into()));
                }
                next.a -= mv.amount;
                next.b += mv.amount;
            }
            Seat::B => {
                if mv.amount > next.b {
                    return Err(ProtocolError("insufficient balance".into()));
                }
                next.b -= mv.amount;
                next.a += mv.amount;
            }
        }
        next.count += 1;
        Ok(next)
    }

    fn encode_state(&self, s: &PayState) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&u64_to_be_bytes(s.a));
        out.extend_from_slice(&u64_to_be_bytes(s.b));
        out.extend_from_slice(&u64_to_be_bytes(s.count));
        out
    }

    fn balances(&self, s: &PayState) -> Balances {
        Balances { a: s.a, b: s.b }
    }

    fn is_terminal(&self, s: &PayState) -> bool {
        s.max_transfers > 0 && s.count >= s.max_transfers
    }

    fn sample_move(
        &self,
        s: &PayState,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<PayMove> {
        if self.is_terminal(s) {
            return None;
        }
        let sampled_actor = if s.count % 2 == 0 { Seat::A } else { Seat::B };
        if seat != sampled_actor {
            return None;
        }
        let balance = if seat == Seat::A { s.a } else { s.b };
        if balance == 0 {
            return None;
        }
        let cap = balance.min(1000);
        let amount = 1 + (rng() * cap as f64).floor() as u64;
        Some(PayMove {
            from: seat,
            amount: amount.max(TRANSFER).min(cap),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_moves_value_and_conserves_total() {
        let p = Payments { max_transfers: 2 };
        let ctx = TunnelContext {
            tunnel_id: "0xab".into(),
            initial: Balances { a: 100, b: 100 },
            seat: Seat::A,
        };
        let s0 = p.initial_state(&ctx);
        let s1 = p
            .apply_move(
                &s0,
                &PayMove {
                    from: Seat::A,
                    amount: 5,
                },
                Seat::A,
            )
            .unwrap();
        assert_eq!((s1.a, s1.b), (95, 105));
        assert_eq!(s1.a + s1.b, 200);
        assert!(p
            .apply_move(
                &s1,
                &PayMove {
                    from: Seat::B,
                    amount: 5,
                },
                Seat::A,
            )
            .is_err());
    }
}
