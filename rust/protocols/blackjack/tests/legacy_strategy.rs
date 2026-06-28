use tunnel_blackjack::{
    duel::BlackjackDuel, BjMove, Blackjack, BlackjackDuelStrategy, BlackjackStrategy,
};
use tunnel_harness::{Balances, MoveStrategy, MoveStrategyContext, Protocol, Seat, TunnelContext};

fn ctx(initial: Balances) -> TunnelContext {
    TunnelContext {
        tunnel_id: "blackjack-legacy-strategy".into(),
        initial,
        seat: Seat::A,
    }
}

fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
    MoveStrategyContext {
        tunnel_id: "blackjack-legacy-strategy".into(),
        seat,
    }
}

#[tokio::test]
async fn bet_strategy_plans_only_for_current_actor() {
    let protocol = Blackjack;
    let state = protocol.initial_state(&ctx(Balances { a: 200, b: 200 }));
    let mut a = BlackjackStrategy;
    let mut b = BlackjackStrategy;

    assert!(matches!(
        a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await,
        Some(BjMove::Bet { .. })
    ));
    assert!(b
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .is_none());
}

#[tokio::test]
async fn duel_strategy_uses_basic_strategy_for_side_to_move_only() {
    let protocol = BlackjackDuel;
    let state = protocol.initial_state(&ctx(Balances {
        a: 20_000_000,
        b: 20_000_000,
    }));
    let mut a = BlackjackDuelStrategy;
    let mut b = BlackjackDuelStrategy;

    assert!(a
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .is_some());
    assert!(b
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .is_none());
}
