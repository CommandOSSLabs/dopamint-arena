use tunnel_battleship::{
    Battleship, BattleshipMove, BattleshipPhase, BattleshipSeries, BattleshipSeriesState,
    BattleshipSeriesStrategy, BattleshipState, BattleshipStrategy, BattleshipWinner, PendingShot,
};
use tunnel_harness::{Balances, MoveStrategy, MoveStrategyContext, Protocol, Seat, TunnelContext};

fn ctx(initial: Balances) -> TunnelContext {
    TunnelContext {
        tunnel_id: "battleship-strategy".into(),
        initial,
        seat: Seat::A,
    }
}

fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
    MoveStrategyContext {
        tunnel_id: "battleship-strategy".into(),
        seat,
    }
}

fn finished_series_state(balance_a: u64, balance_b: u64, stake: u64) -> BattleshipSeriesState {
    BattleshipSeriesState {
        inner: BattleshipState {
            phase: BattleshipPhase::Over,
            turn: Seat::A,
            pending_shot: None,
            commit_a: Some([1; 32]),
            commit_b: Some([2; 32]),
            shots_at_a: Vec::new(),
            shots_at_b: Vec::new(),
            hits_on_a: 17,
            hits_on_b: 0,
            winner: BattleshipWinner::B,
            balance_a: 0,
            balance_b: stake * 2,
            total: stake * 2,
            stake,
        },
        games_played: 0,
        balance_a,
        balance_b,
    }
}

#[tokio::test]
async fn commit_phase_is_serialized_a_then_b() {
    let protocol = Battleship::new(100);
    let state = protocol.initial_state(&ctx(Balances { a: 200, b: 200 }));
    let mut a = BattleshipStrategy::new(1);
    let mut b = BattleshipStrategy::new(2);

    assert!(matches!(
        a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await,
        Some(BattleshipMove::Commit { .. })
    ));
    assert!(b
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .is_none());
}

#[tokio::test]
async fn defender_reveals_pending_shot() {
    let state = BattleshipState {
        phase: BattleshipPhase::Playing,
        turn: Seat::A,
        pending_shot: Some(PendingShot {
            by: Seat::A,
            cell: 3,
        }),
        commit_a: Some([1; 32]),
        commit_b: Some([2; 32]),
        shots_at_a: Vec::new(),
        shots_at_b: Vec::new(),
        hits_on_a: 0,
        hits_on_b: 0,
        winner: BattleshipWinner::None,
        balance_a: 100,
        balance_b: 100,
        total: 200,
        stake: 100,
    };
    let mut attacker = BattleshipStrategy::new(1);
    let mut defender = BattleshipStrategy::new(2);

    assert!(attacker
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .is_none());
    assert!(matches!(
        defender
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await,
        Some(BattleshipMove::Reveal { cell: 3, .. })
    ));
}

#[tokio::test]
async fn series_strategy_uses_configured_stake_and_serializes_rollover_commit() {
    let protocol = BattleshipSeries::new("series", 50);
    let state = finished_series_state(75, 125, 50);
    let mut a = BattleshipSeriesStrategy::new(1, 50);
    let mut b = BattleshipSeriesStrategy::new(2, 50);

    let rollover = a
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .expect("seat A should start the next game");
    assert!(matches!(rollover, BattleshipMove::Commit { .. }));
    assert!(b
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .is_none());

    let next = protocol.apply_move(&state, &rollover, Seat::A).unwrap();
    assert_eq!(next.games_played, 1);
    assert_eq!(next.inner.stake, 50);
    assert!(next.inner.commit_a.is_some());
    assert_eq!(
        protocol.balances(&next).sum(),
        state.balance_a + state.balance_b
    );
}

#[tokio::test]
async fn terminal_series_returns_no_rollover_move() {
    let state = finished_series_state(40, 160, 50);
    let mut strategy = BattleshipSeriesStrategy::new(1, 50);

    assert!(strategy
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .is_none());
}
