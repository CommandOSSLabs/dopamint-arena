use tunnel_harness::{Balances, Protocol, Seat, TunnelContext};
use tunnel_tic_tac_toe::{TicTacToe, TicTacToeMove, Winner, EMPTY, MARK_A, MARK_B};

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "0xab".into(),
        initial: Balances { a: 1000, b: 1000 },
        seat: Seat::A,
    }
}

fn play(
    protocol: &TicTacToe,
    mut state: tunnel_tic_tac_toe::TicTacToeState,
    cells: &[u8],
) -> tunnel_tic_tac_toe::TicTacToeState {
    for &cell in cells {
        let by = state.turn;
        state = protocol
            .apply_move(&state, &TicTacToeMove { cell }, by)
            .unwrap();
    }
    state
}

#[test]
fn initial_state_has_empty_board_turn_and_clamped_stake() {
    let protocol = TicTacToe::new(500).unwrap();
    let state = protocol.initial_state(&TunnelContext {
        tunnel_id: "0xab".into(),
        initial: Balances { a: 300, b: 1000 },
        seat: Seat::A,
    });

    assert_eq!(protocol.name(), "tic_tac_toe.v1");
    assert_eq!(state.board, [EMPTY; 9]);
    assert_eq!(state.turn, Seat::A);
    assert_eq!(state.moves_count, 0);
    assert_eq!(state.winner, Winner::None);
    assert_eq!(state.stake, 300);
    assert_eq!(protocol.balances(&state).sum(), 1300);
}

#[test]
fn moves_place_marks_reject_illegal_cells_and_turns() {
    let protocol = TicTacToe::new(100).unwrap();
    let state = protocol.initial_state(&ctx());

    assert!(protocol
        .apply_move(&state, &TicTacToeMove { cell: 0 }, Seat::B)
        .is_err());
    assert!(protocol
        .apply_move(&state, &TicTacToeMove { cell: 9 }, Seat::A)
        .is_err());

    let after_a = protocol
        .apply_move(&state, &TicTacToeMove { cell: 0 }, Seat::A)
        .unwrap();
    assert_eq!(after_a.board[0], MARK_A);
    assert_eq!(after_a.turn, Seat::B);
    assert!(protocol
        .apply_move(&after_a, &TicTacToeMove { cell: 0 }, Seat::B)
        .is_err());

    let after_b = protocol
        .apply_move(&after_a, &TicTacToeMove { cell: 4 }, Seat::B)
        .unwrap();
    assert_eq!(after_b.board[4], MARK_B);
    assert_eq!(after_b.turn, Seat::A);
}

#[test]
fn decisive_win_shifts_stake_and_draw_keeps_balances() {
    let protocol = TicTacToe::new(100).unwrap();
    let won = play(&protocol, protocol.initial_state(&ctx()), &[0, 3, 1, 4, 2]);
    assert_eq!(won.winner, Winner::A);
    assert_eq!(protocol.balances(&won), Balances { a: 1100, b: 900 });
    assert!(protocol.is_terminal(&won));

    let draw = play(
        &protocol,
        protocol.initial_state(&ctx()),
        &[0, 1, 2, 4, 3, 5, 7, 6, 8],
    );
    assert_eq!(draw.winner, Winner::Draw);
    assert_eq!(protocol.balances(&draw), Balances { a: 1000, b: 1000 });
    assert!(protocol.is_terminal(&draw));
}

#[test]
fn encode_state_matches_domain_and_fixed_layout() {
    let protocol = TicTacToe::new(100).unwrap();
    let state = protocol.initial_state(&ctx());
    let encoded = protocol.encode_state(&state);

    assert!(encoded.starts_with(b"sui_tunnel::proto::tic_tac_toe.v1"));
    assert_eq!(
        encoded.len(),
        b"sui_tunnel::proto::tic_tac_toe.v1".len() + 9 + 3 + 24
    );
    assert_eq!(
        &encoded[b"sui_tunnel::proto::tic_tac_toe.v1".len()..][..9],
        &[0u8; 9]
    );
}

#[test]
fn random_move_only_returns_empty_cell_for_active_turn() {
    let protocol = TicTacToe::new(100).unwrap();
    let state = protocol.initial_state(&ctx());
    assert!(protocol.sample_move(&state, Seat::B, &mut || 0.5).is_none());
    let mv = protocol
        .sample_move(&state, Seat::A, &mut || 0.999)
        .unwrap();
    assert_eq!(mv.cell, 8);
}
