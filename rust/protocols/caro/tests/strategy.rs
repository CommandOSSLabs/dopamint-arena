use tunnel_caro::{
    Caro, CaroMove, CaroSeries, CaroSeriesState, CaroSeriesStrategy, CaroState, CaroStrategy,
    CaroStrength, MARK_A,
};
use tunnel_harness::{Balances, MoveStrategy, MoveStrategyContext, Protocol, Seat, TunnelContext};

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "caro-strategy".into(),
        initial: Balances { a: 100, b: 100 },
        seat: Seat::A,
    }
}

fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
    MoveStrategyContext {
        tunnel_id: "caro-strategy".into(),
        seat,
    }
}

#[tokio::test]
async fn strategy_opens_at_center_and_waits_off_turn() {
    let protocol = Caro::new(15).unwrap();
    let state = protocol.initial_state(&ctx());
    let mut strategy = CaroStrategy::with_seed(15, CaroStrength::Strong, 7).unwrap();

    assert_eq!(
        strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await,
        Some(CaroMove { cell: 112 })
    );
    assert!(strategy
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .is_none());
}

#[tokio::test]
async fn strategy_blocks_immediate_opponent_win() {
    let protocol = Caro::new(15).unwrap();
    let mut state = protocol.initial_state(&ctx());
    for cell in [0, 1, 2, 3] {
        state.board[cell] = 2;
    }
    state.moves_count = 4;
    state.turn = Seat::A;
    let mut strategy = CaroStrategy::with_seed(15, CaroStrength::Strong, 0).unwrap();

    assert_eq!(
        strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await,
        Some(CaroMove { cell: 4 })
    );
}

#[tokio::test]
async fn series_delegates_mid_game_and_only_a_rolls_between_games() {
    let protocol = CaroSeries::new(2, 15).unwrap();
    let mut state = protocol.initial_state(&ctx());
    let mut a = CaroSeriesStrategy::with_seed(2, 15, CaroStrength::Strong, 1).unwrap();
    let mut b = CaroSeriesStrategy::with_seed(2, 15, CaroStrength::Strong, 2).unwrap();

    assert_eq!(
        a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await,
        Some(CaroMove { cell: 112 })
    );

    state.inner.winner = MARK_A;
    state.inner.moves_count = 5;
    assert_eq!(
        a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await,
        Some(CaroMove { cell: 0 })
    );
    assert!(b
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .is_none());
}

#[tokio::test]
async fn terminal_series_returns_none() {
    let state = CaroSeriesState {
        inner: CaroState {
            board: vec![0; 225],
            size: 15,
            turn: Seat::A,
            winner: MARK_A,
            last_move: 4,
            moves_count: 5,
            balance_a: 100,
            balance_b: 100,
            stake: 0,
        },
        games_played: 1,
        max_games: 2,
    };
    let mut strategy = CaroSeriesStrategy::with_seed(2, 15, CaroStrength::Strong, 1).unwrap();

    assert!(strategy
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .is_none());
}
