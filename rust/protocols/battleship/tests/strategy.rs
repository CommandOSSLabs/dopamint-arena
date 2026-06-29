use tunnel_battleship::{
    Battleship, BattleshipMove, BattleshipPhase, BattleshipSeries, BattleshipSeriesState,
    BattleshipSeriesStrategy, BattleshipState, BattleshipStrategy, BattleshipWinner, PendingShot,
};
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, InMemoryAnchor, InMemoryFrameTransport, LocalSigner, MoveStrategy,
    MoveStrategyContext, NullTranscriptRecorder, PartyDriver, Protocol, Seat, SeatParts,
    TunnelContext,
};

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

fn parts(
    seat: Seat,
    secret: &[u8; 32],
    opponent_pk: [u8; 32],
) -> SeatParts<BattleshipSeries, LocalSigner> {
    SeatParts {
        protocol: BattleshipSeries::new("party-driver-battleship", 100),
        signer: LocalSigner::from_secret(secret),
        opponent_pk,
        initial: Balances { a: 200, b: 200 },
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
async fn planned_commit_shoot_and_reveal_apply_cleanly() {
    let protocol = Battleship::new(100);
    let mut state = protocol.initial_state(&ctx(Balances { a: 200, b: 200 }));
    let mut a = BattleshipStrategy::new(1);
    let mut b = BattleshipStrategy::new(2);

    let commit_a = a
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .expect("seat A should commit first");
    state = protocol.apply_move(&state, &commit_a, Seat::A).unwrap();

    let commit_b = b
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .expect("seat B should commit after A");
    state = protocol.apply_move(&state, &commit_b, Seat::B).unwrap();
    assert_eq!(state.phase, BattleshipPhase::Playing);

    let shoot = a
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .expect("seat A should shoot on turn");
    state = protocol.apply_move(&state, &shoot, Seat::A).unwrap();
    assert!(matches!(
        state.pending_shot,
        Some(PendingShot { by: Seat::A, .. })
    ));

    let reveal = b
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .expect("seat B should reveal the pending shot");
    state = protocol.apply_move(&state, &reveal, Seat::B).unwrap();

    assert!(state.pending_shot.is_none());
    assert_eq!(state.turn, Seat::B);
    assert_eq!(protocol.balances(&state).sum(), 400);
}

#[tokio::test]
async fn direct_strategy_play_reaches_terminal_and_conserves_balances() {
    let protocol = Battleship::new(100);
    let mut state = protocol.initial_state(&ctx(Balances { a: 200, b: 200 }));
    let mut a = BattleshipStrategy::new(1);
    let mut b = BattleshipStrategy::new(2);

    for _ in 0..1000 {
        if state.phase == BattleshipPhase::Over {
            assert_eq!(protocol.balances(&state).sum(), 400);
            return;
        }

        let mut moved = false;
        if let Some(mv) = a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await {
            state = protocol.apply_move(&state, &mv, Seat::A).unwrap();
            moved = true;
        }
        if let Some(mv) = b.plan_move(&state, Seat::B, &strategy_ctx(Seat::B)).await {
            state = protocol.apply_move(&state, &mv, Seat::B).unwrap();
            moved = true;
        }
        assert!(moved, "at least one strategy should advance the game");
    }

    panic!("strategy self-play did not reach terminal state");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn party_driver_series_self_play_conserves_balances() {
    let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&secret_a).public_key();
    let pk_b = keypair_from_secret(&secret_b).public_key();
    let (ch_a, ch_b) = InMemoryFrameTransport::pair();

    let anchor = InMemoryAnchor::new();
    let driver_a = PartyDriver::new(
        parts(Seat::A, &secret_a, pk_b),
        BattleshipSeriesStrategy::new(1, 100),
        ch_a,
        anchor.clone(),
        NullTranscriptRecorder,
    );
    let driver_b = PartyDriver::new(
        parts(Seat::B, &secret_b, pk_a),
        BattleshipSeriesStrategy::new(2, 100),
        ch_b,
        anchor.clone(),
        NullTranscriptRecorder,
    );

    let (out_a, out_b) = tokio::join!(driver_a.run(1000, || 1), driver_b.run(1000, || 1));
    let out_a = out_a.unwrap().0;
    let out_b = out_b.unwrap().0;

    assert_eq!(out_a.final_balances.sum(), 400);
    assert_eq!(out_a.final_balances, out_b.final_balances);
    assert!(out_a.moves > 0);
}
