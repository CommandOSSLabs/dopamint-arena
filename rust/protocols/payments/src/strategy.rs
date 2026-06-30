use crate::{PayMove, PayState, Payments};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, ProtocolError, Seat};

#[derive(Clone, Copy, Debug)]
pub struct PaymentsStrategy {
    payment_amount: u64,
}

impl PaymentsStrategy {
    pub fn new(payment_amount: u64) -> Result<Self, ProtocolError> {
        if payment_amount == 0 {
            return Err(ProtocolError("payment amount must be positive".into()));
        }
        Ok(Self { payment_amount })
    }
}

impl MoveStrategy<Payments> for PaymentsStrategy {
    async fn plan_move(
        &mut self,
        state: &PayState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<PayMove> {
        if seat != Seat::A || state.a < self.payment_amount {
            return None;
        }
        Some(PayMove {
            from: Seat::A,
            amount: self.payment_amount,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_core::crypto::keypair_from_secret;
    use tunnel_harness::{
        Balances, InMemoryAnchor, InMemoryFrameTransport, LocalSigner, NullTranscriptRecorder,
        PartyDriver, Protocol, SeatParts, TunnelContext,
    };

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "payments-strategy".into(),
            initial: Balances { a: 100, b: 100 },
            seat: Seat::A,
        }
    }

    fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
        MoveStrategyContext {
            tunnel_id: "payments-strategy".into(),
            seat,
        }
    }

    #[tokio::test]
    async fn shop_never_proposes_payments() {
        let protocol = Payments { max_transfers: 10 };
        let state = protocol.initial_state(&ctx());
        let mut strategy = PaymentsStrategy::new(5).unwrap();

        let planned = strategy
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await;

        assert!(planned.is_none());
    }

    #[tokio::test]
    async fn payer_proposes_fixed_micro_payment_when_funded() {
        let protocol = Payments { max_transfers: 10 };
        let state = protocol.initial_state(&ctx());
        let mut strategy = PaymentsStrategy::new(5).unwrap();

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert_eq!(planned.map(|mv| (mv.from, mv.amount)), Some((Seat::A, 5)));
    }

    #[tokio::test]
    async fn payer_stops_when_underfunded() {
        let state = PayState {
            a: 4,
            b: 196,
            total: 200,
            count: 0,
            max_transfers: 10,
        };
        let mut strategy = PaymentsStrategy::new(5).unwrap();

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert!(planned.is_none());
    }

    #[tokio::test]
    async fn planned_payment_advances_state_and_conserves_total() {
        let protocol = Payments { max_transfers: 10 };
        let state = protocol.initial_state(&ctx());
        let mut strategy = PaymentsStrategy::new(5).unwrap();

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("payer should plan");
        let next = protocol.apply_move(&state, &planned, Seat::A).unwrap();

        assert_eq!(next.count, 1);
        assert_eq!((next.a, next.b), (95, 105));
        assert_eq!(next.a + next.b, state.total);
    }

    #[tokio::test]
    async fn confirm_and_abort_do_not_change_stateless_decisions() {
        let protocol = Payments { max_transfers: 10 };
        let state = protocol.initial_state(&ctx());
        let mut strategy = PaymentsStrategy::new(5).unwrap();

        let before = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;
        strategy.confirm_move(&state);
        strategy.abort();
        let after = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert_eq!(
            before.map(|mv| (mv.from, mv.amount)),
            after.map(|mv| (mv.from, mv.amount))
        );
    }

    fn parts(
        seat: Seat,
        secret: &[u8; 32],
        opponent_pk: [u8; 32],
    ) -> SeatParts<Payments, LocalSigner> {
        SeatParts {
            protocol: Payments { max_transfers: 4 },
            signer: LocalSigner::from_secret(secret),
            opponent_pk,
            initial: Balances { a: 100, b: 100 },
            seat,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn self_play_terminates_at_cap_and_conserves_balances() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();

        let anchor = InMemoryAnchor::with_fixed_id("0xcd");
        let driver_a = PartyDriver::new(
            parts(Seat::A, &secret_a, pk_b),
            PaymentsStrategy::new(5).unwrap(),
            ch_a,
            anchor.clone(),
            NullTranscriptRecorder,
        );
        let driver_b = PartyDriver::new(
            parts(Seat::B, &secret_b, pk_a),
            PaymentsStrategy::new(5).unwrap(),
            ch_b,
            anchor.clone(),
            NullTranscriptRecorder,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(100, || 1), driver_b.run(100, || 1));
        let out_a = out_a.unwrap().0;
        let out_b = out_b.unwrap().0;

        assert_eq!(out_a.final_balances.sum(), 200);
        assert_eq!(out_a.final_balances, out_b.final_balances);
        assert_eq!(out_a.moves, 4);
    }
}
