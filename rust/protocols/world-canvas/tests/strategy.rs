use tunnel_harness::{Balances, MoveStrategy, MoveStrategyContext, Protocol, Seat, TunnelContext};
use tunnel_world_canvas::{
    strategy::{WorldCanvasCellStrategy, WorldCanvasStrokeStrategy},
    RenderCell, StrokeCanvasState, WorldCanvasCell, WorldCanvasStroke, CHUNK_SIZE,
};

fn ctx(initial: Balances) -> TunnelContext {
    TunnelContext {
        tunnel_id: "world-canvas-strategy".into(),
        initial,
        seat: Seat::A,
    }
}

fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
    MoveStrategyContext {
        tunnel_id: "world-canvas-strategy".into(),
        seat,
    }
}

#[tokio::test]
async fn cell_strategy_paints_until_cap() {
    let protocol = WorldCanvasCell::new(256, 16, 1).unwrap();
    let state = protocol.initial_state(&ctx(Balances { a: 100, b: 100 }));
    let mut strategy = WorldCanvasCellStrategy::new(protocol, 1);
    let planned = strategy
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .expect("uncapped canvas should plan");

    assert!(planned.x < 256);
    assert!(planned.y < 256);
    assert!(planned.color < 16);

    let terminal = protocol
        .apply_move(&state, &planned, Seat::A)
        .expect("strategy move is legal");
    assert!(strategy
        .plan_move(&terminal, Seat::A, &strategy_ctx(Seat::A))
        .await
        .is_none());
}

#[tokio::test]
async fn stroke_strategy_continues_this_seats_recent_line() {
    let state = StrokeCanvasState {
        digest: [0; 32],
        cells: vec![
            RenderCell {
                gx: 9,
                gy: 10,
                color: 7,
                by: Seat::A,
                seq: 1,
                pseq: 4,
            },
            RenderCell {
                gx: 10,
                gy: 10,
                color: 7,
                by: Seat::A,
                seq: 2,
                pseq: 5,
            },
        ],
        paint_count: 2,
        updates: 2,
        applied_seq_a: 5,
        applied_seq_b: 0,
        balance_a: 100,
        balance_b: 100,
        total: 200,
    };
    let mut strategy = WorldCanvasStrokeStrategy::new(7);

    let planned = strategy
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await
        .expect("stroke strategy should plan");

    assert_eq!(planned.cells.len(), 8);
    assert_eq!(planned.cells[0].seq, 6);
    let gx = planned.cells[0].cx * CHUNK_SIZE as i64 + planned.cells[0].x as i64;
    let gy = planned.cells[0].cy * CHUNK_SIZE as i64 + planned.cells[0].y as i64;
    assert!((gx - 10).abs() <= 2);
    assert!((gy - 10).abs() <= 2);
    assert!(planned.cells.iter().all(|cell| cell.color == 13));
}

#[tokio::test]
async fn stroke_strategy_applies_and_conserves_balances() {
    let protocol = WorldCanvasStroke;
    let state = protocol.initial_state(&ctx(Balances { a: 100, b: 100 }));
    let mut strategy = WorldCanvasStrokeStrategy::new(1);
    let planned = strategy
        .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
        .await
        .expect("stroke strategy should plan");
    let next = protocol.apply_move(&state, &planned, Seat::B).unwrap();

    assert_eq!(next.applied_seq_b, 8);
    assert_eq!(protocol.balances(&next), Balances { a: 100, b: 100 });
}
