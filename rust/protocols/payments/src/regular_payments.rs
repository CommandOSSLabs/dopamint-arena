//! Tunnel Mart arena profile: `payments.v1` with catalog-price enforcement on shopper (A) moves.
//! Mirrors FE `verifyMove` / agent-kit `isCatalogPaymentMove`.

use crate::catalog::is_catalog_amount;
use crate::{PayMove, PayState, Payments};
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

/// Shopper moves must use a catalog price; shop (B) refund moves are unconstrained here.
#[derive(Clone, Copy, Debug)]
pub struct RegularPayments(pub Payments);

impl Protocol for RegularPayments {
    type State = PayState;
    type Move = PayMove;

    fn name(&self) -> &str {
        self.0.name()
    }

    fn initial_state(&self, ctx: &TunnelContext) -> PayState {
        self.0.initial_state(ctx)
    }

    fn apply_move(&self, s: &PayState, mv: &PayMove, by: Seat) -> Result<PayState, ProtocolError> {
        if mv.from == Seat::A && !is_catalog_amount(mv.amount) {
            return Err(ProtocolError(
                "payment amount does not match any catalog item price".into(),
            ));
        }
        self.0.apply_move(s, mv, by)
    }

    fn encode_state(&self, s: &PayState) -> Vec<u8> {
        self.0.encode_state(s)
    }

    fn balances(&self, s: &PayState) -> Balances {
        self.0.balances(s)
    }

    fn is_terminal(&self, s: &PayState) -> bool {
        self.0.is_terminal(s)
    }

    fn can_gracefully_close(&self, s: &PayState) -> bool {
        self.0.can_gracefully_close(s)
    }

    fn sample_move(
        &self,
        s: &PayState,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<PayMove> {
        self.0.sample_move(s, seat, rng)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::Balances;

    fn ctx() -> TunnelContext {
        // Matches `REGULAR_PAYMENTS.stake_each` / FE `DEPOSIT_BUDGET` (500 whole MTPS per seat).
        TunnelContext {
            tunnel_id: "mart".into(),
            initial: Balances { a: 500, b: 500 },
            seat: Seat::B,
        }
    }

    #[test]
    fn rejects_non_catalog_shopper_amount() {
        let p = RegularPayments(Payments { max_transfers: 0 });
        let s = p.initial_state(&ctx());
        let err = p
            .apply_move(
                &s,
                &PayMove {
                    from: Seat::A,
                    amount: 99,
                },
                Seat::A,
            )
            .unwrap_err();
        assert!(err.0.contains("catalog"));
    }

    #[test]
    fn accepts_catalog_shopper_amount() {
        let p = RegularPayments(Payments { max_transfers: 0 });
        let s = p.initial_state(&ctx());
        let next = p
            .apply_move(
                &s,
                &PayMove {
                    from: Seat::A,
                    amount: crate::catalog::CATALOG_PRICE_LO,
                },
                Seat::A,
            )
            .unwrap();
        assert_eq!(next.a, 499);
        assert_eq!(next.b, 501);
    }
}
