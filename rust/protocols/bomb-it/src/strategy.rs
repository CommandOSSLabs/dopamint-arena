use crate::{
    hunter_action, BombIt, BombItAction, BombItMove, BombItSeries, BombItSeriesState, BombItState,
};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Protocol, Seat};

#[derive(Clone, Copy, Debug)]
pub struct BombItStrategy {
    rng_state: u32,
}

impl BombItStrategy {
    pub fn new(seed: u64) -> Self {
        Self {
            rng_state: seed as u32,
        }
    }

    fn next_f64(&mut self) -> f64 {
        self.rng_state = self.rng_state.wrapping_add(0x6d2b_79f5);
        let mut t = (self.rng_state ^ (self.rng_state >> 15)).wrapping_mul(1 | self.rng_state);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

impl MoveStrategy<BombIt> for BombItStrategy {
    async fn plan_move(
        &mut self,
        state: &BombItState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<BombItMove> {
        if BombIt.is_terminal(state) || turn_of(state.tick) != seat {
            return None;
        }
        let mut rng = || self.next_f64();
        let action = hunter_action(state, seat, &mut rng);
        Some(match seat {
            Seat::A => BombItMove {
                a: Some(action),
                b: None,
            },
            Seat::B => BombItMove {
                a: None,
                b: Some(action),
            },
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct BombItSeriesStrategy {
    inner: BombItStrategy,
    stake_per_game: u64,
}

impl BombItSeriesStrategy {
    pub fn new(seed: u64, stake_per_game: u64) -> Self {
        Self {
            inner: BombItStrategy::new(seed),
            stake_per_game,
        }
    }
}

impl MoveStrategy<BombItSeries> for BombItSeriesStrategy {
    async fn plan_move(
        &mut self,
        state: &BombItSeriesState,
        seat: Seat,
        ctx: &MoveStrategyContext,
    ) -> Option<BombItMove> {
        if state.inner.winner.is_none() {
            return self.inner.plan_move(&state.inner, seat, ctx).await;
        }
        let can_continue = self.stake_per_game == 0
            || (state.balance_a >= self.stake_per_game && state.balance_b >= self.stake_per_game);
        if !can_continue || seat != Seat::A {
            return None;
        }
        Some(BombItMove {
            a: Some(BombItAction::Stay),
            b: None,
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
    use crate::{BombItAction, BombItWinner};
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

    #[test]
    fn strategy_rng_matches_ts_mulberry32_stream() {
        let mut strategy = BombItStrategy::new(1);
        assert_close(strategy.next_f64(), 0.62707394058816135);
        assert_close(strategy.next_f64(), 0.0027357211802154779);
        assert_close(strategy.next_f64(), 0.52744703995995224);
    }

    #[tokio::test]
    async fn tick_zero_is_only_seat_a_turn() {
        let protocol = BombIt;
        let state = protocol.initial_state(&ctx());
        let mut a = BombItStrategy::new(1);
        let mut b = BombItStrategy::new(2);

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
    async fn planned_move_carries_only_acting_seat_action() {
        let protocol = BombIt;
        let mut state = protocol.initial_state(&ctx());
        let mut a = BombItStrategy::new(1);
        let mut b = BombItStrategy::new(2);

        let move_a = a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("A should plan on even tick");
        assert!(move_a.a.is_some());
        assert_eq!(move_a.b, None);
        state = protocol.apply_move(&state, &move_a, Seat::A).unwrap();

        let move_b = b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .expect("B should plan on odd tick");
        assert_eq!(move_b.a, None);
        assert!(move_b.b.is_some());
    }

    #[tokio::test]
    async fn planned_move_advances_tick_and_conserves_balances() {
        let protocol = BombIt;
        let state = protocol.initial_state(&ctx());
        let mut strategy = BombItStrategy::new(1);

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("A should plan");
        let next = protocol.apply_move(&state, &planned, Seat::A).unwrap();

        assert_eq!(next.tick, state.tick + 1);
        assert_eq!(protocol.balances(&next).sum(), state.total);
    }

    #[tokio::test]
    async fn dead_player_plans_stay_on_its_tick() {
        let protocol = BombIt;
        let mut state = protocol.initial_state(&ctx());
        state.players[0].alive = false;
        let mut strategy = BombItStrategy::new(1);

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert_eq!(planned, Some(BombItMove::stay_for(Seat::A)));
    }

    #[tokio::test]
    async fn player_in_blast_takes_shortest_escape_step() {
        let state = BombItState {
            tick: 0,
            seed: 0,
            grid: vec![crate::CELL_FLOOR; crate::CELL_COUNT],
            players: [
                crate::BombItPlayer {
                    row: 5,
                    col: 5,
                    alive: true,
                },
                crate::BombItPlayer {
                    row: 10,
                    col: 10,
                    alive: true,
                },
            ],
            bombs: vec![crate::BombItBomb {
                row: 5,
                col: 5,
                fuse: 3,
                owner: Seat::A,
            }],
            winner: None,
            balance_a: 100,
            balance_b: 100,
            total: 200,
        };
        let mut strategy = BombItStrategy::new(1);

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert_eq!(
            planned,
            Some(BombItMove {
                a: Some(BombItAction::North),
                b: None
            })
        );
    }

    #[tokio::test]
    async fn series_kickoff_is_only_seat_a_while_session_live() {
        let protocol = BombItSeries::new("0xabc123", 100);
        let mut state = protocol.initial_state(&ctx());
        state.inner.winner = Some(BombItWinner::Draw);
        state.balance_a = 100;
        state.balance_b = 100;
        let mut strategy = BombItSeriesStrategy::new(1, 100);

        let a = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;
        let b = strategy
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await;

        assert_eq!(
            a,
            Some(BombItMove {
                a: Some(BombItAction::Stay),
                b: None,
            })
        );
        assert!(b.is_none());
    }

    #[tokio::test]
    async fn series_self_play_reaches_terminal_or_tick_cap_and_conserves_balances() {
        let protocol = BombItSeries::new("0xabc123", 100);
        let mut state = protocol.initial_state(&ctx());
        let mut a = BombItSeriesStrategy::new(1, 100);
        let mut b = BombItSeriesStrategy::new(2, 100);

        for _ in 0..crate::BOMB_IT_TICK_CAP + 8 {
            if protocol.is_terminal(&state) || state.inner.tick >= crate::BOMB_IT_TICK_CAP {
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

        assert!(protocol.is_terminal(&state) || state.inner.tick >= crate::BOMB_IT_TICK_CAP);
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < f64::EPSILON,
            "expected {expected}, got {actual}"
        );
    }
}
