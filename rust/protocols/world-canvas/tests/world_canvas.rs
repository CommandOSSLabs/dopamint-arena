use tunnel_harness::{Balances, Protocol, Seat, TunnelContext};
use tunnel_world_canvas::{
    encode_cell_move, CellPaintMove, StrokeCellMove, StrokePaintMove, WorldCanvasCell,
    WorldCanvasStroke, CHUNK_SIZE, MAX_BATCH_CELLS,
};

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "0xworld".into(),
        initial: Balances { a: 100, b: 100 },
        seat: Seat::A,
    }
}

#[test]
fn cell_protocol_folds_each_paint_and_keeps_balances_locked() {
    let protocol = WorldCanvasCell::default();
    assert_eq!(protocol.name(), "world_canvas.cell.v1");
    let initial = protocol.initial_state(&ctx());
    assert_eq!(initial.count, 0);
    assert_eq!(initial.rolling_digest, [0u8; 32]);

    let first = protocol
        .apply_move(
            &initial,
            &CellPaintMove {
                cx: 0,
                cy: 0,
                x: 1,
                y: 2,
                color: 3,
            },
            Seat::A,
        )
        .unwrap();
    let second = protocol
        .apply_move(
            &first,
            &CellPaintMove {
                cx: 0,
                cy: 0,
                x: 1,
                y: 2,
                color: 3,
            },
            Seat::A,
        )
        .unwrap();
    assert_eq!(second.count, 2);
    assert_ne!(first.rolling_digest, second.rolling_digest);
    assert_eq!(protocol.balances(&second), Balances { a: 100, b: 100 });
}

#[test]
fn cell_protocol_rejects_out_of_range_paints_and_caps() {
    let protocol = WorldCanvasCell::new(256, 16, 1).unwrap();
    let state = protocol.initial_state(&ctx());
    assert!(protocol
        .apply_move(
            &state,
            &CellPaintMove {
                cx: 0,
                cy: 0,
                x: 256,
                y: 0,
                color: 0,
            },
            Seat::A,
        )
        .is_err());
    let terminal = protocol
        .apply_move(
            &state,
            &CellPaintMove {
                cx: 0,
                cy: 0,
                x: 0,
                y: 0,
                color: 0,
            },
            Seat::A,
        )
        .unwrap();
    assert!(protocol.is_terminal(&terminal));
}

#[test]
fn cell_move_encoding_is_painter_sensitive() {
    let mv = CellPaintMove {
        cx: -1,
        cy: 4,
        x: 255,
        y: 0,
        color: 15,
    };
    assert_ne!(
        encode_cell_move(&mv, Seat::A),
        encode_cell_move(&mv, Seat::B)
    );
}

#[test]
fn stroke_protocol_folds_fresh_cells_and_skips_replayed_seq() {
    let protocol = WorldCanvasStroke;
    assert_eq!(protocol.name(), "world_canvas.stroke.v1");
    let state = protocol.initial_state(&ctx());
    let first = protocol
        .apply_move(
            &state,
            &StrokePaintMove {
                cells: vec![
                    StrokeCellMove::new(0, 0, 1, 2, 3, 1),
                    StrokeCellMove::new(0, 0, 2, 2, 3, 2),
                ],
            },
            Seat::A,
        )
        .unwrap();
    let replayed = protocol
        .apply_move(
            &first,
            &StrokePaintMove {
                cells: vec![
                    StrokeCellMove::new(0, 0, 1, 2, 3, 1),
                    StrokeCellMove::new(0, 0, 3, 2, 3, 3),
                ],
            },
            Seat::A,
        )
        .unwrap();
    assert_eq!(replayed.applied_seq_a, 3);
    assert_eq!(replayed.paint_count, 3);
    assert_ne!(
        protocol.encode_state(&first),
        protocol.encode_state(&replayed)
    );
}

#[test]
fn stroke_protocol_rejects_bad_batch_and_bad_cells() {
    let protocol = WorldCanvasStroke;
    let state = protocol.initial_state(&ctx());
    assert!(protocol
        .apply_move(
            &state,
            &StrokePaintMove {
                cells: vec![StrokeCellMove::new(0, 0, CHUNK_SIZE, 0, 0, 1)],
            },
            Seat::A,
        )
        .is_err());
    assert!(protocol
        .apply_move(
            &state,
            &StrokePaintMove {
                cells: (0..=MAX_BATCH_CELLS)
                    .map(|i| StrokeCellMove::new(0, 0, 0, 0, 0, i as u64 + 1))
                    .collect(),
            },
            Seat::A,
        )
        .is_err());
}
