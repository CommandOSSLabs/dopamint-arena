//! Payments as a tunnel Protocol: the signing seat transfers value to the other
//! seat. This ports the canonical TS `payments.v1` move shape; `max_transfers`
//! is only a harness cap for bounded self-play tests.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub mod catalog;
pub mod regular_payments;
pub mod strategy;
pub use catalog::{is_catalog_amount, CATALOG_PRICE_HI, CATALOG_PRICE_LO};
pub use regular_payments::RegularPayments;
pub use strategy::{PaymentsStrategy, ShopPosStrategy};

const DOMAIN: &[u8] = b"sui_tunnel::proto::payments.v1";
const TRANSFER: u64 = 1;

/// Move-wire serde: the relayed move is JSON (`JsonFrameCodec`), and the FE
/// `paymentsMoveCodec` sends `amount` as a decimal string. Branch on
/// `is_human_readable()` so bench codecs (bcs/postcard) keep plain `u64`.
mod wire_dec_u64 {
    pub fn serialize<S: serde::Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&v.to_string())
        } else {
            s.serialize_u64(*v)
        }
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        use serde::Deserialize;
        if d.is_human_readable() {
            String::deserialize(d)?
                .parse()
                .map_err(serde::de::Error::custom)
        } else {
            u64::deserialize(d)
        }
    }
}

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
    #[serde(with = "wire_dec_u64")]
    pub amount: u64,
}

#[derive(Clone, Copy, Debug)]
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

    fn can_gracefully_close(&self, _s: &PayState) -> bool {
        true
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

    #[test]
    fn move_json_matches_ts_payments_move_codec() {
        use serde_json::json;
        assert_eq!(
            serde_json::to_value(PayMove {
                from: Seat::A,
                amount: 2,
            })
            .unwrap(),
            json!({ "from": "A", "amount": "2" }),
        );
        let mv: PayMove = serde_json::from_value(json!({ "from": "A", "amount": "1" })).unwrap();
        assert_eq!(mv.from, Seat::A);
        assert_eq!(mv.amount, 1);
    }

    #[test]
    fn ordinary_payment_state_is_gracefully_closeable() {
        let p = Payments { max_transfers: 2 };
        let ctx = TunnelContext {
            tunnel_id: "0xab".into(),
            initial: Balances { a: 100, b: 100 },
            seat: Seat::A,
        };
        let state = p.initial_state(&ctx);

        assert!(p.can_gracefully_close(&state));
        assert!(!p.is_terminal(&state));
    }
}
