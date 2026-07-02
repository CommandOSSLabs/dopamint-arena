//! World Canvas protocols: single-cell collaborative painting and batched stroke
//! painting. Uses canonical Rust IDs `world_canvas.cell.v1` and
//! `world_canvas.stroke.v1`.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_core::crypto::blake2b256;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub mod strategy;
pub use strategy::{WorldCanvasCellStrategy, WorldCanvasStrokeStrategy};

pub const CHUNK_SIZE: u64 = 256;
pub const NUM_COLORS: u64 = 16;
pub const DEFAULT_CAP: u64 = 1_000_000_000_000;
pub const MAX_BATCH_CELLS: usize = 128;
const MAX_RENDER_CELLS: usize = 8000;
/// Auto-settle ceiling for the winner-less stroke canvas: terminal once this many CO-SIGNED UPDATES
/// (tunnel moves) are applied — the canonical per-tunnel update cap. Counted by `updates` (bumped per
/// move that folds ≥1 fresh cell, replay-safe). MUST equal the TS `WORLD_CANVAS_UPDATE_CAP` and stay
/// ≤ the fleet `MAX_MOVES`, so the cooperative `is_terminal` fires before the max-moves backstop.
pub const WORLD_CANVAS_UPDATE_CAP: u64 = 100_000;

const CELL_DOMAIN: &[u8] = b"sui_tunnel::proto::world_canvas.cell.v1";
const STROKE_DOMAIN: &[u8] = b"sui_tunnel::proto::world_canvas.stroke.v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CellPaintMove {
    pub cx: i64,
    pub cy: i64,
    pub x: u64,
    pub y: u64,
    pub color: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellCanvasState {
    pub rolling_digest: [u8; 32],
    pub count: u64,
    pub last_painter: Option<Seat>,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
}

fn painter_byte(seat: Seat) -> u8 {
    match seat {
        Seat::A => 0x01,
        Seat::B => 0x02,
    }
}

fn zigzag64(n: i64) -> u64 {
    ((n << 1) ^ (n >> 63)) as u64
}

fn rolling_digest(prev: &[u8; 32], delta: &[u8]) -> [u8; 32] {
    let mut input = Vec::with_capacity(32 + delta.len());
    input.extend_from_slice(prev);
    input.extend_from_slice(delta);
    blake2b256(&input)
}

pub fn encode_cell_move(mv: &CellPaintMove, by: Seat) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + 8 * 4 + 1);
    out.push(painter_byte(by));
    out.extend_from_slice(&u64_to_be_bytes(zigzag64(mv.cx)));
    out.extend_from_slice(&u64_to_be_bytes(zigzag64(mv.cy)));
    out.extend_from_slice(&u64_to_be_bytes(mv.x));
    out.extend_from_slice(&u64_to_be_bytes(mv.y));
    out.push(mv.color as u8);
    out
}

#[derive(Clone, Copy, Debug)]
pub struct WorldCanvasCell {
    chunk_size: u64,
    num_colors: u64,
    cap: u64,
}

impl WorldCanvasCell {
    pub fn new(chunk_size: u64, num_colors: u64, cap: u64) -> Result<Self, ProtocolError> {
        if chunk_size == 0 {
            return Err(ProtocolError("chunkSize must be positive".into()));
        }
        if num_colors == 0 {
            return Err(ProtocolError("numColors must be positive".into()));
        }
        if cap == 0 {
            return Err(ProtocolError("cap must be positive".into()));
        }
        Ok(WorldCanvasCell {
            chunk_size,
            num_colors,
            cap,
        })
    }
}

impl Default for WorldCanvasCell {
    fn default() -> Self {
        WorldCanvasCell {
            chunk_size: CHUNK_SIZE,
            num_colors: NUM_COLORS,
            cap: DEFAULT_CAP,
        }
    }
}

impl Protocol for WorldCanvasCell {
    type State = CellCanvasState;
    type Move = CellPaintMove;

    fn name(&self) -> &str {
        "world_canvas.cell.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> CellCanvasState {
        CellCanvasState {
            rolling_digest: [0u8; 32],
            count: 0,
            last_painter: None,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            total: ctx.initial.sum(),
        }
    }

    fn apply_move(
        &self,
        state: &CellCanvasState,
        mv: &CellPaintMove,
        by: Seat,
    ) -> Result<CellCanvasState, ProtocolError> {
        if state.count >= self.cap {
            return Err(ProtocolError("canvas paint cap reached".into()));
        }
        if mv.x >= self.chunk_size {
            return Err(ProtocolError(format!("x out of range: {}", mv.x)));
        }
        if mv.y >= self.chunk_size {
            return Err(ProtocolError(format!("y out of range: {}", mv.y)));
        }
        if mv.color >= self.num_colors {
            return Err(ProtocolError(format!("color out of range: {}", mv.color)));
        }
        Ok(CellCanvasState {
            rolling_digest: rolling_digest(&state.rolling_digest, &encode_cell_move(mv, by)),
            count: state.count + 1,
            last_painter: Some(by),
            balance_a: state.balance_a,
            balance_b: state.balance_b,
            total: state.total,
        })
    }

    fn encode_state(&self, state: &CellCanvasState) -> Vec<u8> {
        let mut out = Vec::with_capacity(CELL_DOMAIN.len() + 32 + 24);
        out.extend_from_slice(CELL_DOMAIN);
        out.extend_from_slice(&state.rolling_digest);
        out.extend_from_slice(&u64_to_be_bytes(state.count));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_a));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_b));
        out
    }

    fn balances(&self, state: &CellCanvasState) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &CellCanvasState) -> bool {
        state.count >= self.cap
    }

    fn can_gracefully_close(&self, _state: &CellCanvasState) -> bool {
        true
    }

    fn sample_move(
        &self,
        state: &CellCanvasState,
        _seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<CellPaintMove> {
        if self.is_terminal(state) {
            return None;
        }
        let spread = 8i64;
        let pick =
            |rng: &mut dyn FnMut() -> f64, n: u64| ((rng() * n as f64).floor() as u64).min(n - 1);
        Some(CellPaintMove {
            cx: pick(rng, (2 * spread + 1) as u64) as i64 - spread,
            cy: pick(rng, (2 * spread + 1) as u64) as i64 - spread,
            x: pick(rng, self.chunk_size),
            y: pick(rng, self.chunk_size),
            color: pick(rng, self.num_colors),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StrokeCellMove {
    pub cx: i64,
    pub cy: i64,
    pub x: u64,
    pub y: u64,
    pub color: u64,
    pub seq: u64,
}

impl StrokeCellMove {
    pub fn new(cx: i64, cy: i64, x: u64, y: u64, color: u64, seq: u64) -> Self {
        StrokeCellMove {
            cx,
            cy,
            x,
            y,
            color,
            seq,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StrokePaintMove {
    pub cells: Vec<StrokeCellMove>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderCell {
    pub gx: i64,
    pub gy: i64,
    pub color: u64,
    pub by: Seat,
    pub seq: u64,
    pub pseq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrokeCanvasState {
    pub digest: [u8; 32],
    pub cells: Vec<RenderCell>,
    pub paint_count: u64,
    /// Co-signed updates applied — bumped once per move that folds ≥1 fresh cell (replay-safe). The
    /// auto-settle terminal reads this; MUST mirror the TS `updates`. Not in `encode_state`.
    pub updates: u64,
    pub applied_seq_a: u64,
    pub applied_seq_b: u64,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct WorldCanvasStroke;

fn cell_delta(cell: &StrokeCellMove, by: Seat) -> Vec<u8> {
    format!(
        "{}|{},{}|{},{}|{}",
        match by {
            Seat::A => "A",
            Seat::B => "B",
        },
        cell.cx,
        cell.cy,
        cell.x,
        cell.y,
        cell.color
    )
    .into_bytes()
}

fn legal_stroke_cell(cell: &StrokeCellMove) -> bool {
    cell.x < CHUNK_SIZE && cell.y < CHUNK_SIZE && cell.color < NUM_COLORS
}

impl Protocol for WorldCanvasStroke {
    type State = StrokeCanvasState;
    type Move = StrokePaintMove;

    fn name(&self) -> &str {
        "world_canvas.stroke.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> StrokeCanvasState {
        StrokeCanvasState {
            digest: blake2b256(STROKE_DOMAIN),
            cells: Vec::new(),
            paint_count: 0,
            updates: 0,
            applied_seq_a: 0,
            applied_seq_b: 0,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            total: ctx.initial.sum(),
        }
    }

    fn apply_move(
        &self,
        state: &StrokeCanvasState,
        mv: &StrokePaintMove,
        by: Seat,
    ) -> Result<StrokeCanvasState, ProtocolError> {
        if mv.cells.len() > MAX_BATCH_CELLS {
            return Err(ProtocolError("world-canvas-stroke: illegal batch".into()));
        }
        let mut digest = state.digest;
        let mut paint_count = state.paint_count;
        let mut applied_seq_a = state.applied_seq_a;
        let mut applied_seq_b = state.applied_seq_b;
        let mut cells = state.cells.clone();

        for cell in &mv.cells {
            if !legal_stroke_cell(cell) {
                return Err(ProtocolError("world-canvas-stroke: illegal paint".into()));
            }
            let applied = match by {
                Seat::A => applied_seq_a,
                Seat::B => applied_seq_b,
            };
            if cell.seq <= applied {
                continue;
            }
            match by {
                Seat::A => applied_seq_a = cell.seq,
                Seat::B => applied_seq_b = cell.seq,
            }
            digest = rolling_digest(&digest, &cell_delta(cell, by));
            paint_count += 1;
            cells.push(RenderCell {
                gx: cell.cx * CHUNK_SIZE as i64 + cell.x as i64,
                gy: cell.cy * CHUNK_SIZE as i64 + cell.y as i64,
                color: cell.color,
                by,
                seq: paint_count,
                pseq: cell.seq,
            });
        }
        if cells.len() > MAX_RENDER_CELLS {
            cells = cells.split_off(cells.len() - MAX_RENDER_CELLS);
        }
        Ok(StrokeCanvasState {
            digest,
            cells,
            paint_count,
            // One co-signed update iff this move folded ≥1 fresh cell — a replayed move (all cells
            // skipped by the seq gate) never advances it, so `updates` stays identical on both seats.
            updates: if paint_count > state.paint_count {
                state.updates + 1
            } else {
                state.updates
            },
            applied_seq_a,
            applied_seq_b,
            balance_a: state.balance_a,
            balance_b: state.balance_b,
            total: state.total,
        })
    }

    fn encode_state(&self, state: &StrokeCanvasState) -> Vec<u8> {
        state.digest.to_vec()
    }

    fn balances(&self, state: &StrokeCanvasState) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &StrokeCanvasState) -> bool {
        state.updates >= WORLD_CANVAS_UPDATE_CAP
    }

    fn can_gracefully_close(&self, _state: &StrokeCanvasState) -> bool {
        true
    }

    /// Free co-draw: turns are invisible in `encode_state` (an idle `{cells:[]}` move advances only
    /// the nonce, leaving the digest/counters identical), so neither seat can self-gate from state.
    /// Pin strict alternation by nonce parity — byte-identical to the FE engine's
    /// `turn(nonce) = nonce % 2 === 0 ? A : B` (frontend/src/pvp/pvpMatchHook.ts): A proposes 0→1,
    /// B 1→2, A 2→3, … So exactly one seat proposes per nonce and no cross-propose can abort co-sign.
    fn proposer_for_nonce(&self, nonce: u64) -> Option<Seat> {
        Some(if nonce % 2 == 0 { Seat::A } else { Seat::B })
    }

    fn sample_move(
        &self,
        state: &StrokeCanvasState,
        by: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<StrokePaintMove> {
        let start_seq = match by {
            Seat::A => state.applied_seq_a,
            Seat::B => state.applied_seq_b,
        };
        let mut cells = Vec::new();
        let mut gx = if by == Seat::A { 0 } else { 70 };
        let mut gy = 0i64;
        for seq in (start_seq + 1..).take(8) {
            gx += ((rng() * 3.0).floor() as i64 - 1).clamp(-2, 2);
            gy += ((rng() * 3.0).floor() as i64 - 1).clamp(-2, 2);
            let cx = gx.div_euclid(CHUNK_SIZE as i64);
            let cy = gy.div_euclid(CHUNK_SIZE as i64);
            cells.push(StrokeCellMove {
                cx,
                cy,
                x: (gx - cx * CHUNK_SIZE as i64) as u64,
                y: (gy - cy * CHUNK_SIZE as i64) as u64,
                color: 13,
                seq,
            });
        }
        Some(StrokePaintMove { cells })
    }
}

#[cfg(test)]
mod wire_parity {
    use super::*;

    // The relayed move is JSON (the fleet's JsonFrameCodec), so the bot's `StrokePaintMove` must
    // serialize to the EXACT shape the FE `WorldCanvasPvpProtocol` sends — a `cells` array of plain
    // {cx,cy,x,y,color,seq} ints (no codec) — or the human's tunnel rejects the frame.
    #[test]
    fn move_json_matches_fe_world_canvas_wire() {
        let mv = StrokePaintMove {
            cells: vec![StrokeCellMove {
                cx: -1,
                cy: 2,
                x: 3,
                y: 4,
                color: 13,
                seq: 7,
            }],
        };
        assert_eq!(
            serde_json::to_value(&mv).unwrap(),
            serde_json::json!({
                "cells": [{ "cx": -1, "cy": 2, "x": 3, "y": 4, "color": 13, "seq": 7 }]
            }),
        );
        let parsed: StrokePaintMove = serde_json::from_value(serde_json::json!({
            "cells": [{ "cx": 0, "cy": 0, "x": 1, "y": 1, "color": 0, "seq": 1 }]
        }))
        .unwrap();
        assert_eq!(parsed.cells.len(), 1);
    }

    // The co-signed genesis digest is `blake2b256(domain)`; the domain MUST equal the FE's
    // `protocolDomain("world_canvas.stroke.v1")` = "sui_tunnel::proto::world_canvas.stroke.v1", or the
    // two parties' INITIAL state hashes differ and co-signing fails before any move is even painted.
    #[test]
    fn genesis_domain_matches_fe_protocol_domain() {
        assert_eq!(STROKE_DOMAIN, b"sui_tunnel::proto::world_canvas.stroke.v1");
    }

    #[test]
    fn ordinary_canvas_states_are_gracefully_closeable() {
        let ctx = TunnelContext {
            tunnel_id: "0xcanvas".into(),
            initial: Balances { a: 10, b: 10 },
            seat: Seat::A,
        };
        let cell = WorldCanvasCell::default();
        let stroke = WorldCanvasStroke;

        let cell_state = cell.initial_state(&ctx);
        let stroke_state = stroke.initial_state(&ctx);

        assert!(cell.can_gracefully_close(&cell_state));
        assert!(!cell.is_terminal(&cell_state));
        assert!(stroke.can_gracefully_close(&stroke_state));
        assert!(!stroke.is_terminal(&stroke_state));
    }
}
