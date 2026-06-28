use crate::{ApiCredits, ApiCreditsMove, ApiCreditsState};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, ProtocolError, Seat};

#[derive(Clone, Copy, Debug)]
pub struct ApiCreditsStrategy {
    cost_per_call: u64,
}

impl ApiCreditsStrategy {
    pub fn new(cost_per_call: u64) -> Result<Self, ProtocolError> {
        if cost_per_call == 0 {
            return Err(ProtocolError("costPerCall must be positive".into()));
        }
        Ok(Self { cost_per_call })
    }
}

impl MoveStrategy<ApiCredits> for ApiCreditsStrategy {
    async fn plan_move(
        &mut self,
        state: &ApiCreditsState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<ApiCreditsMove> {
        if seat != Seat::A || state.client < self.cost_per_call {
            return None;
        }
        Some(ApiCreditsMove::Call)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::{Balances, Protocol, TunnelContext};

    fn protocol() -> ApiCredits {
        ApiCredits::new(10).unwrap()
    }

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "0xac".into(),
            initial: Balances { a: 35, b: 100 },
            seat: Seat::A,
        }
    }

    fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
        MoveStrategyContext {
            tunnel_id: "0xac".into(),
            seat,
        }
    }

    #[tokio::test]
    async fn provider_never_proposes_calls() {
        let state = protocol().initial_state(&ctx());
        let mut strategy = ApiCreditsStrategy::new(10).unwrap();

        let planned = strategy
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await;

        assert!(planned.is_none());
    }

    #[tokio::test]
    async fn client_proposes_call_when_funded() {
        let state = protocol().initial_state(&ctx());
        let mut strategy = ApiCreditsStrategy::new(10).unwrap();

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert_eq!(planned, Some(ApiCreditsMove::Call));
    }

    #[tokio::test]
    async fn client_stops_when_credit_is_exhausted() {
        let state = ApiCreditsState {
            client: 9,
            provider: 126,
            total: 135,
            calls: 3,
        };
        let mut strategy = ApiCreditsStrategy::new(10).unwrap();

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert!(planned.is_none());
    }

    #[tokio::test]
    async fn planned_call_advances_state_and_conserves_total() {
        let protocol = protocol();
        let state = protocol.initial_state(&ctx());
        let mut strategy = ApiCreditsStrategy::new(10).unwrap();

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("client should plan");
        let next = protocol.apply_move(&state, &planned, Seat::A).unwrap();

        assert_eq!(next.calls, 1);
        assert_eq!((next.client, next.provider), (25, 110));
        assert_eq!(next.client + next.provider, state.total);
    }

    #[tokio::test]
    async fn self_play_stops_when_client_cannot_fund_another_call() {
        let protocol = protocol();
        let mut state = protocol.initial_state(&ctx());
        let mut client = ApiCreditsStrategy::new(10).unwrap();
        let mut provider = ApiCreditsStrategy::new(10).unwrap();

        for _ in 0..10 {
            assert!(provider
                .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
                .await
                .is_none());

            let Some(mv) = client
                .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
                .await
            else {
                break;
            };
            state = protocol.apply_move(&state, &mv, Seat::A).unwrap();
            assert_eq!(state.client + state.provider, state.total);
        }

        assert_eq!(state.calls, 3);
        assert!(protocol.is_terminal(&state));
        assert!(client
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .is_none());
    }
}
