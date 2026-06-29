use tunnel_caro::{
    Caro, CaroSeries, CaroSeriesState, CaroSeriesStrategy, CaroState, CaroStrategy,
    CaroStrength, MARK_A,
};
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, InMemoryFrameTransport, LocalSigner, MoveStrategy, MoveStrategyContext, PartyDriver,
    PartyRuntime, Protocol, Seat, TunnelContext,
};

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

fn runtime(
    seat: Seat,
    secret: &[u8; 32],
    opponent_pk: [u8; 32],
) -> PartyRuntime<CaroSeries, LocalSigner> {
    PartyRuntime::new(
        CaroSeries::new(2, 15, 0).unwrap(),
        LocalSigner::from_secret(secret),
        opponent_pk,
        TunnelContext {
            tunnel_id: "0xca70".into(),
            initial: Balances { a: 100, b: 100 },
            seat,
        },
    )
}

#[tokio::test]
async fn plan_move_is_idempotent_for_replayed_state() {
    let protocol = Caro::new(15, 0).unwrap();
    let state = protocol.initial_state(&ctx());
    // Place one mark so pick_cell exercises the scoring path (moves_count > 0).
    let mut state = state;
    state.board[112] = MARK_A;
    state.moves_count = 1;
    state.turn = Seat::B;

    let mut strategy = CaroStrategy::with_seed(15, CaroStrength::Strong, 42).unwrap();

    let a = strategy
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await;
    let b = strategy
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await;
    let c = strategy
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await;

    assert!(a.is_some(), "expected a move");
    assert_eq!(a.as_ref().map(|m| &m.salt), b.as_ref().map(|m| &m.salt), "salt must be idempotent");
    assert_eq!(a.as_ref().map(|m| &m.salt), c.as_ref().map(|m| &m.salt), "salt must be idempotent");
}

#[tokio::test]
async fn strategy_opens_at_center_and_waits_off_turn() {
    let protocol = Caro::new(15, 0).unwrap();
    let state = protocol.initial_state(&ctx());
    let mut strategy = CaroStrategy::with_seed(15, CaroStrength::Strong, 7).unwrap();

    let mv = strategy
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await;
    assert!(mv.is_some_and(|m| m.cell == 112), "expected center cell 112");
    assert!(strategy
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .is_none());
}

#[tokio::test]
async fn strategy_blocks_immediate_opponent_win() {
    let protocol = Caro::new(15, 0).unwrap();
    let mut state = protocol.initial_state(&ctx());
    for cell in [0, 1, 2, 3] {
        state.board[cell] = 2;
    }
    state.moves_count = 4;
    state.turn = Seat::A;
    let mut strategy = CaroStrategy::with_seed(15, CaroStrength::Strong, 0).unwrap();

    let mv = strategy
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await;
    assert!(mv.is_some_and(|m| m.cell == 4), "expected block at cell 4");
}

#[tokio::test]
async fn series_delegates_mid_game_and_only_a_rolls_between_games() {
    let protocol = CaroSeries::new(2, 15, 0).unwrap();
    let mut state = protocol.initial_state(&ctx());
    let mut a = CaroSeriesStrategy::with_seed(2, 15, CaroStrength::Strong, 1).unwrap();
    let mut b = CaroSeriesStrategy::with_seed(2, 15, CaroStrength::Strong, 2).unwrap();

    let mv = a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await;
    assert!(mv.is_some_and(|m| m.cell == 112), "expected center cell 112");

    state.inner.winner = MARK_A;
    state.inner.moves_count = 5;
    let mv_a = a
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await;
    assert!(mv_a.is_some_and(|m| m.cell == 0), "expected kickoff cell 0");
    assert!(b
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .is_none());

    let rollover = a
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .unwrap();
    // Rollover move must have a valid salt so apply_move accepts it.
    assert!(rollover.salt.len() >= 16, "rollover move must have >= 16-byte salt");
    let next = protocol.apply_move(&state, &rollover, Seat::A).unwrap();

    assert_eq!(next.games_played, 1);
    assert_eq!(next.inner.moves_count, 0);
    assert_eq!(next.inner.winner, 0);
    assert!(next.inner.board.iter().all(|&cell| cell == 0));
    assert_eq!(protocol.balances(&next), Balances { a: 100, b: 100 });
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
            move_accumulator: [0u8; 32],
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn party_driver_series_self_play_conserves_balances() {
    let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&secret_a).public_key();
    let pk_b = keypair_from_secret(&secret_b).public_key();
    let (ch_a, ch_b) = InMemoryFrameTransport::pair();

    let driver_a = PartyDriver::new(
        runtime(Seat::A, &secret_a, pk_b),
        CaroSeriesStrategy::with_seed(2, 15, CaroStrength::Strong, 1).unwrap(),
        ch_a,
    );
    let driver_b = PartyDriver::new(
        runtime(Seat::B, &secret_b, pk_a),
        CaroSeriesStrategy::with_seed(2, 15, CaroStrength::Strong, 2).unwrap(),
        ch_b,
    );

    let (out_a, out_b) = tokio::join!(driver_a.run(1000, || 1), driver_b.run(1000, || 1));
    let out_a = out_a.unwrap();
    let out_b = out_b.unwrap();

    assert_eq!(out_a.final_balances, Balances { a: 100, b: 100 });
    assert_eq!(out_a.final_balances, out_b.final_balances);
    assert!(out_a.moves > 0);
}
