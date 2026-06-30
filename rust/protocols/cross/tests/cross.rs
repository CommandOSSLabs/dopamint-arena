use tunnel_cross::{
    dest_of, hazards_at, is_lethal, lane_kind, Cross, CrossDir, CrossLaneKind, CrossMove,
    CrossState, COLUMN_COUNT, SPAWN_COL, TICK_CAP, WIN_LANE,
};
use tunnel_harness::{Balances, Protocol, Seat, TunnelContext};

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "0xabc123".into(),
        initial: Balances { a: 100, b: 100 },
        seat: Seat::A,
    }
}

#[test]
fn lane_kind_cycles_like_ts_protocol() {
    assert_eq!(lane_kind(0), CrossLaneKind::Grass);
    assert_eq!(lane_kind(1), CrossLaneKind::Grass);
    assert_eq!(lane_kind(2), CrossLaneKind::Road);
    assert_eq!(lane_kind(3), CrossLaneKind::Road);
    assert_eq!(lane_kind(4), CrossLaneKind::Water);
    assert_eq!(lane_kind(5), CrossLaneKind::Rails);
    assert_eq!(lane_kind(6), CrossLaneKind::Grass);
    assert_eq!(lane_kind(7), CrossLaneKind::Grass);
    assert_eq!(lane_kind(8), CrossLaneKind::Road);
}

#[test]
fn hazards_are_deterministic_and_water_is_inverted() {
    assert_eq!(hazards_at(777, 2, 9), hazards_at(777, 2, 9));
    let seed = 999;
    let lane = 4;
    let tick = 13;
    let spans = hazards_at(seed, lane, tick);
    for col in 0..COLUMN_COUNT {
        let c = col as f64 + 0.5;
        let on_log = spans.iter().any(|span| {
            [c, c - COLUMN_COUNT as f64, c + COLUMN_COUNT as f64]
                .iter()
                .any(|cc| *cc > span.center - span.half && *cc < span.center + span.half)
        });
        assert_eq!(is_lethal(seed, col, lane, tick), !on_log);
    }
}

#[test]
fn destinations_clamp_to_board() {
    assert_eq!(dest_of(3, 4, CrossDir::North), (4, 4));
    assert_eq!(dest_of(3, 4, CrossDir::South), (2, 4));
    assert_eq!(dest_of(0, 4, CrossDir::South), (0, 4));
    assert_eq!(dest_of(3, 8, CrossDir::East), (3, 8));
    assert_eq!(dest_of(3, 0, CrossDir::West), (3, 0));
}

#[test]
fn initial_state_and_encoding_are_deterministic() {
    let protocol = Cross;
    let state = protocol.initial_state(&ctx());
    assert_eq!(protocol.name(), "cross.v1");
    assert_eq!(state.tick, 0);
    assert_eq!(state.players[0].lane, 0);
    assert_eq!(state.players[0].col, SPAWN_COL);
    assert_eq!(protocol.balances(&state).sum(), 200);

    let encoded = protocol.encode_state(&state);
    assert!(encoded.starts_with(b"sui_tunnel::proto::cross.v1"));
    assert_eq!(
        encoded.len(),
        b"sui_tunnel::proto::cross.v1".len() + 8 * 12 + 1
    );
    assert_eq!(
        encoded,
        protocol.encode_state(&protocol.initial_state(&ctx()))
    );
}

#[test]
fn moves_advance_tick_and_conserve_balances() {
    let protocol = Cross;
    let mut state = protocol.initial_state(&ctx());
    for i in 0..200 {
        let by = if i % 2 == 0 { Seat::A } else { Seat::B };
        let mv = protocol.sample_move(&state, by, &mut || 0.42).unwrap();
        state = protocol.apply_move(&state, &mv, by).unwrap();
        assert_eq!(protocol.balances(&state).sum(), 200);
        if protocol.is_terminal(&state) {
            break;
        }
    }
    assert!(state.tick > 0);
}

#[test]
fn terminal_state_rejects_more_moves_and_dead_heat_pushes() {
    let protocol = Cross;
    let mut state = protocol.initial_state(&ctx());
    state.winner = Some(Seat::A);
    state.balance_a = state.total;
    state.balance_b = 0;
    assert!(protocol
        .apply_move(
            &state,
            &CrossMove {
                dir_a: Some(CrossDir::North),
                dir_b: None,
            },
            Seat::A,
        )
        .is_err());

    let mut dead_heat: CrossState = protocol.initial_state(&ctx());
    dead_heat.tick = 10;
    dead_heat.players[0].lane = WIN_LANE - 1;
    dead_heat.players[0].score = WIN_LANE - 1;
    dead_heat.players[1].lane = WIN_LANE;
    dead_heat.players[1].score = WIN_LANE;
    let next = protocol
        .apply_move(
            &dead_heat,
            &CrossMove {
                dir_a: Some(CrossDir::North),
                dir_b: None,
            },
            Seat::A,
        )
        .unwrap();
    assert_eq!(next.winner, None);
    assert_eq!(next.balance_a, dead_heat.balance_a);
    assert_eq!(next.balance_b, dead_heat.balance_b);
}

#[test]
fn seat_cannot_drive_opponent_chicken() {
    let protocol = Cross;
    let state = protocol.initial_state(&ctx());
    assert!(protocol
        .apply_move(
            &state,
            &CrossMove {
                dir_a: None,
                dir_b: Some(CrossDir::North),
            },
            Seat::A,
        )
        .is_err());
    assert!(protocol
        .apply_move(
            &state,
            &CrossMove {
                dir_a: Some(CrossDir::North),
                dir_b: None,
            },
            Seat::B,
        )
        .is_err());
}

#[test]
fn random_move_only_carries_acting_seat_direction() {
    let protocol = Cross;
    let state = protocol.initial_state(&ctx());
    let a = protocol.sample_move(&state, Seat::A, &mut || 0.1).unwrap();
    assert!(a.dir_a.is_some() || a.dir_a.is_none());
    assert_eq!(a.dir_b, None);
    let b = protocol.sample_move(&state, Seat::B, &mut || 0.1).unwrap();
    assert_eq!(b.dir_a, None);
}

#[test]
fn tick_cap_is_terminal_push_floor() {
    let protocol = Cross;
    let mut state = protocol.initial_state(&ctx());
    state.tick = TICK_CAP;
    assert!(protocol.is_terminal(&state));
}
