//! Payments as a tunnel Protocol: the current actor transfers a small amount to the
//! other seat. Proves the harness drives non-game state. Terminal after `max_transfers`.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

const DOMAIN: &[u8] = b"sui_tunnel::proto::payments.v1";
const TRANSFER: u64 = 1;

#[derive(Clone, Debug)]
pub struct PayState {
    pub a: u64,
    pub b: u64,
    pub total: u64,
    pub transfers: u64,
    pub max_transfers: u64,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct PayMove {
    pub amount: u64,
}

/// Whose turn it is: A on even transfer count, B on odd.
fn actor(s: &PayState) -> Seat {
    if s.transfers % 2 == 0 {
        Seat::A
    } else {
        Seat::B
    }
}

pub struct Payments {
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
            transfers: 0,
            max_transfers: self.max_transfers,
        }
    }

    fn apply_move(
        &self,
        s: &PayState,
        mv: &PayMove,
        by: Seat,
    ) -> Result<PayState, ProtocolError> {
        if by != actor(s) {
            return Err(ProtocolError("not this seat's turn".into()));
        }
        if mv.amount == 0 {
            return Err(ProtocolError("amount must be positive".into()));
        }
        let mut next = s.clone();
        match by {
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
        next.transfers += 1;
        Ok(next)
    }

    fn encode_state(&self, s: &PayState) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&u64_to_be_bytes(s.a));
        out.extend_from_slice(&u64_to_be_bytes(s.b));
        out.extend_from_slice(&u64_to_be_bytes(s.transfers));
        out
    }

    fn balances(&self, s: &PayState) -> Balances {
        Balances { a: s.a, b: s.b }
    }

    fn is_terminal(&self, s: &PayState) -> bool {
        s.transfers >= s.max_transfers
    }

    fn sample_move(
        &self,
        s: &PayState,
        seat: Seat,
        _rng: &mut dyn FnMut() -> f64,
    ) -> Option<PayMove> {
        if self.is_terminal(s) || actor(s) != seat {
            return None;
        }
        Some(PayMove { amount: TRANSFER })
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
        let s1 = p.apply_move(&s0, &PayMove { amount: 5 }, Seat::A).unwrap();
        assert_eq!((s1.a, s1.b), (95, 105));
        assert_eq!(s1.a + s1.b, 200);
        assert!(p.apply_move(&s1, &PayMove { amount: 5 }, Seat::A).is_err()); // wrong turn
    }
}
