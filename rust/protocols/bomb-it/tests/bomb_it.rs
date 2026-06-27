use tunnel_bomb_it::{
    blast_cells_for, build_grid, can_move_to, dest, idx, is_border, is_pillar, resolve_explosions,
    BombIt, BombItAction, BombItBomb, BombItMove, BombItPlayer, BombItWinner, CELL_CRATE,
    CELL_FLOOR, CELL_WALL, FUSE_TICKS, GRID_H, GRID_W, SPAWN_B,
};
use tunnel_harness::{Balances, Protocol, Seat, TunnelContext};

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "0xabc123".into(),
        initial: Balances { a: 100, b: 100 },
        seat: Seat::A,
    }
}

fn dead_far() -> BombItPlayer {
    BombItPlayer {
        row: 8,
        col: 8,
        alive: false,
    }
}

fn spawn_at(row: i64, col: i64) -> BombItPlayer {
    BombItPlayer {
        row,
        col,
        alive: true,
    }
}

fn clear_interior(mut grid: Vec<u8>) -> Vec<u8> {
    for row in 1..GRID_H - 1 {
        for col in 1..GRID_W - 1 {
            if !is_pillar(row, col) {
                grid[idx(row, col)] = CELL_FLOOR;
            }
        }
    }
    grid
}

#[test]
fn grid_has_walls_pillars_spawn_floor_and_symmetry() {
    assert!(is_border(0, 3));
    assert!(is_border(GRID_H - 1, GRID_W - 1));
    assert!(is_pillar(2, 2));
    assert!(!is_pillar(1, 1));

    let grid = build_grid(42);
    assert_eq!(grid.len(), GRID_W as usize * GRID_H as usize);
    assert_eq!(grid[idx(0, 1)], CELL_WALL);
    assert_eq!(grid[idx(2, 2)], CELL_WALL);
    assert_eq!(grid[idx(1, 1)], CELL_FLOOR);
    assert_eq!(grid[idx(SPAWN_B.row, SPAWN_B.col)], CELL_FLOOR);

    for row in 0..GRID_H {
        for col in 0..GRID_W {
            assert_eq!(
                grid[idx(row, col)],
                grid[idx(GRID_H - 1 - row, GRID_W - 1 - col)]
            );
        }
    }
}

#[test]
fn movement_and_blast_helpers_match_rules() {
    assert_eq!(dest(3, 4, BombItAction::North), (2, 4));
    assert_eq!(dest(3, 4, BombItAction::Bomb), (3, 4));

    let grid = build_grid(7);
    assert!(!can_move_to(&grid, &[], &dead_far(), 0, 1));
    assert!(can_move_to(&grid, &[], &dead_far(), 1, 1));
    assert!(!can_move_to(
        &grid,
        &[BombItBomb {
            row: 1,
            col: 1,
            fuse: FUSE_TICKS,
            owner: Seat::A,
        }],
        &dead_far(),
        1,
        1
    ));

    let mut open = vec![CELL_FLOOR; GRID_W as usize * GRID_H as usize];
    open[idx(3, 5)] = CELL_WALL;
    open[idx(1, 3)] = CELL_CRATE;
    let cells = blast_cells_for(
        &open,
        &BombItBomb {
            row: 3,
            col: 3,
            fuse: 0,
            owner: Seat::A,
        },
    );
    assert!(cells.contains(&idx(3, 3)));
    assert!(cells.contains(&idx(1, 3)));
    assert!(!cells.contains(&idx(3, 5)));
}

#[test]
fn explosions_chain_clear_crates_and_leave_shielded_bombs() {
    let mut open = vec![CELL_FLOOR; GRID_W as usize * GRID_H as usize];
    open[idx(1, 3)] = CELL_CRATE;
    let bombs = vec![
        BombItBomb {
            row: 3,
            col: 3,
            fuse: 0,
            owner: Seat::A,
        },
        BombItBomb {
            row: 3,
            col: 5,
            fuse: FUSE_TICKS,
            owner: Seat::B,
        },
    ];
    let resolved = resolve_explosions(&mut open, bombs);
    assert!(resolved.remaining.is_empty());
    assert_eq!(open[idx(1, 3)], CELL_FLOOR);

    let mut shielded = vec![CELL_FLOOR; GRID_W as usize * GRID_H as usize];
    shielded[idx(3, 4)] = CELL_CRATE;
    let resolved = resolve_explosions(
        &mut shielded,
        vec![
            BombItBomb {
                row: 3,
                col: 3,
                fuse: 0,
                owner: Seat::A,
            },
            BombItBomb {
                row: 3,
                col: 5,
                fuse: FUSE_TICKS,
                owner: Seat::B,
            },
        ],
    );
    assert_eq!(resolved.remaining.len(), 1);
    assert_eq!(resolved.remaining[0].owner, Seat::B);
}

#[test]
fn protocol_initial_state_encoding_and_integrity_checks() {
    let protocol = BombIt;
    let state = protocol.initial_state(&ctx());
    assert_eq!(protocol.name(), "bomb_it.v1");
    assert_eq!(state.tick, 0);
    assert_eq!(state.players[0], spawn_at(1, 1));
    assert_eq!(state.players[1], spawn_at(SPAWN_B.row, SPAWN_B.col));
    assert_eq!(protocol.balances(&state).sum(), 200);
    assert!(protocol
        .encode_state(&state)
        .starts_with(b"sui_tunnel::proto::bomb_it.v1"));

    assert!(protocol
        .apply_move(
            &state,
            &BombItMove {
                a: None,
                b: Some(BombItAction::Bomb),
            },
            Seat::A,
        )
        .is_err());
}

#[test]
fn bomb_tick_can_draw_or_pay_winner_and_conserves_total() {
    let protocol = BombIt;
    let base = protocol.initial_state(&ctx());
    let mut state = base.clone();
    state.grid = clear_interior(base.grid);
    state.players = [spawn_at(1, 1), spawn_at(1, 2)];

    state = protocol
        .apply_move(
            &state,
            &BombItMove {
                a: Some(BombItAction::Bomb),
                b: None,
            },
            Seat::A,
        )
        .unwrap();
    for _ in 0..FUSE_TICKS {
        let seat = if state.tick % 2 == 0 {
            Seat::A
        } else {
            Seat::B
        };
        state = protocol
            .apply_move(&state, &BombItMove::stay_for(seat), seat)
            .unwrap();
        if protocol.is_terminal(&state) {
            break;
        }
    }
    assert_eq!(state.winner, Some(BombItWinner::Draw));
    assert_eq!(protocol.balances(&state).sum(), 200);
}
