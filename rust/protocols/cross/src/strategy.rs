use crate::{greedy_dir, Cross, CrossMove, CrossSeries, CrossSeriesState, CrossState};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Protocol, Seat};

#[derive(Clone, Copy, Debug)]
pub struct CrossStrategy {
    rng_state: u64,
}

impl CrossStrategy {
    pub fn new(seed: u64) -> Self {
        Self { rng_state: seed }
    }

    fn next_f64(&mut self) -> f64 {
        self.rng_state = self.rng_state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.rng_state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    }
}

impl MoveStrategy<Cross> for CrossStrategy {
    async fn plan_move(
        &mut self,
        state: &CrossState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<CrossMove> {
        if Cross.is_terminal(state) || turn_of(state.tick) != seat {
            return None;
        }
        let player_index = if seat == Seat::A { 0 } else { 1 };
        let mut rng = || self.next_f64();
        let dir = greedy_dir(state, player_index, &mut rng);
        Some(match seat {
            Seat::A => CrossMove {
                dir_a: dir,
                dir_b: None,
            },
            Seat::B => CrossMove {
                dir_a: None,
                dir_b: dir,
            },
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CrossSeriesStrategy {
    inner: CrossStrategy,
    stake_per_game: u64,
}

impl CrossSeriesStrategy {
    pub fn new(seed: u64, stake_per_game: u64) -> Self {
        Self {
            inner: CrossStrategy::new(seed),
            stake_per_game,
        }
    }
}

impl MoveStrategy<CrossSeries> for CrossSeriesStrategy {
    async fn plan_move(
        &mut self,
        state: &CrossSeriesState,
        seat: Seat,
        ctx: &MoveStrategyContext,
    ) -> Option<CrossMove> {
        if state.inner.winner.is_none() && state.inner.tick < crate::TICK_CAP {
            return self.inner.plan_move(&state.inner, seat, ctx).await;
        }
        let can_continue = self.stake_per_game == 0
            || (state.balance_a >= self.stake_per_game && state.balance_b >= self.stake_per_game);
        if !can_continue || seat != Seat::A {
            return None;
        }
        Some(CrossMove {
            dir_a: None,
            dir_b: None,
        })
    }
}

fn turn_of(tick: u64) -> Seat {
    if tick % 2 == 0 {
        Seat::A
    } else {
        Seat::B
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::{Balances, Protocol, TunnelContext};

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "0xabc123".into(),
            initial: Balances { a: 100, b: 100 },
            seat: Seat::A,
        }
    }

    fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
        MoveStrategyContext {
            tunnel_id: "0xabc123".into(),
            seat,
        }
    }

    #[tokio::test]
    async fn tick_zero_is_only_seat_a_turn() {
        let protocol = Cross;
        let state = protocol.initial_state(&ctx());
        let mut a = CrossStrategy::new(1);
        let mut b = CrossStrategy::new(2);

        assert!(a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .is_some());
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn planned_move_carries_only_acting_seat_direction() {
        let protocol = Cross;
        let mut state = protocol.initial_state(&ctx());
        let mut a = CrossStrategy::new(1);
        let mut b = CrossStrategy::new(2);

        let move_a = a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("A should plan on even tick");
        assert_eq!(move_a.dir_b, None);
        state = protocol.apply_move(&state, &move_a, Seat::A).unwrap();

        let move_b = b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .expect("B should plan on odd tick");
        assert_eq!(move_b.dir_a, None);
    }

    #[tokio::test]
    async fn planned_move_advances_tick_and_conserves_balances() {
        let protocol = Cross;
        let state = protocol.initial_state(&ctx());
        let mut strategy = CrossStrategy::new(1);

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("A should plan");
        let next = protocol.apply_move(&state, &planned, Seat::A).unwrap();

        assert_eq!(next.tick, state.tick + 1);
        assert_eq!(protocol.balances(&next).sum(), state.total);
    }

    #[tokio::test]
    async fn series_kickoff_is_only_seat_a_while_session_live() {
        let protocol = CrossSeries::new("0xabc123", 100);
        let mut state = protocol.initial_state(&ctx());
        state.inner.winner = Some(Seat::A);
        state.inner.balance_a = state.inner.total;
        state.inner.balance_b = 0;
        state.balance_a = 200;
        state.balance_b = 200;
        let mut strategy = CrossSeriesStrategy::new(1, 100);

        let a = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;
        let b = strategy
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await;

        assert_eq!(
            a,
            Some(CrossMove {
                dir_a: None,
                dir_b: None,
            })
        );
        assert!(b.is_none());
    }

    #[tokio::test]
    async fn active_series_uses_even_odd_tick_gating() {
        let protocol = CrossSeries::new("0xabc123", 100);
        let state = protocol.initial_state(&ctx());
        let mut a = CrossSeriesStrategy::new(1, 100);
        let mut b = CrossSeriesStrategy::new(2, 100);

        assert!(a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .is_some());
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn series_self_play_reaches_terminal_or_tick_cap_and_conserves_balances() {
        let protocol = CrossSeries::new("0xabc123", 100);
        let mut state = protocol.initial_state(&TunnelContext {
            tunnel_id: "0xabc123".into(),
            initial: Balances { a: 100, b: 100 },
            seat: Seat::A,
        });
        let mut a = CrossSeriesStrategy::new(1, 100);
        let mut b = CrossSeriesStrategy::new(2, 100);

        for _ in 0..crate::TICK_CAP + 8 {
            if protocol.is_terminal(&state) || state.inner.tick >= crate::TICK_CAP {
                break;
            }
            let planned_a = a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await;
            let planned_b = b.plan_move(&state, Seat::B, &strategy_ctx(Seat::B)).await;
            let (seat, mv) = match (planned_a, planned_b) {
                (Some(mv), None) => (Seat::A, mv),
                (None, Some(mv)) => (Seat::B, mv),
                other => panic!("expected exactly one planned move, got {other:?}"),
            };
            state = protocol.apply_move(&state, &mv, seat).unwrap();
            assert_eq!(protocol.balances(&state).sum(), 200);
        }

        assert!(protocol.is_terminal(&state) || state.inner.tick >= crate::TICK_CAP);
    }
}
