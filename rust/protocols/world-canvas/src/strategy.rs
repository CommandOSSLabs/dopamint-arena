use crate::{
    CellCanvasState, CellPaintMove, RenderCell, StrokeCanvasState, StrokeCellMove, StrokePaintMove,
    WorldCanvasCell, WorldCanvasStroke, CHUNK_SIZE, MAX_BATCH_CELLS, NUM_COLORS,
};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Protocol, Seat};

#[derive(Clone, Copy, Debug)]
pub struct WorldCanvasCellStrategy {
    protocol: WorldCanvasCell,
    rng_state: u64,
}

impl WorldCanvasCellStrategy {
    pub fn new(protocol: WorldCanvasCell, seed: u64) -> Self {
        Self {
            protocol,
            rng_state: seed,
        }
    }

    fn next_f64(&mut self) -> f64 {
        self.rng_state = splitmix_next(self.rng_state);
        (self.rng_state >> 11) as f64 / (1u64 << 53) as f64
    }

    fn pick(&mut self, n: u64) -> u64 {
        ((self.next_f64() * n as f64).floor() as u64).min(n - 1)
    }
}

impl MoveStrategy<WorldCanvasCell> for WorldCanvasCellStrategy {
    async fn plan_move(
        &mut self,
        state: &CellCanvasState,
        _seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<CellPaintMove> {
        if self.protocol.is_terminal(state) {
            return None;
        }
        let spread = 8i64;
        let chunk_size = self.protocol.chunk_size;
        let num_colors = self.protocol.num_colors;
        Some(CellPaintMove {
            cx: self.pick((2 * spread + 1) as u64) as i64 - spread,
            cy: self.pick((2 * spread + 1) as u64) as i64 - spread,
            x: self.pick(chunk_size),
            y: self.pick(chunk_size),
            color: self.pick(num_colors),
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct WorldCanvasStrokeStrategy {
    rng_state: u64,
}

impl WorldCanvasStrokeStrategy {
    pub fn new(seed: u64) -> Self {
        Self { rng_state: seed }
    }

    fn next_f64(&mut self) -> f64 {
        self.rng_state = splitmix_next(self.rng_state);
        (self.rng_state >> 11) as f64 / (1u64 << 53) as f64
    }
}

impl MoveStrategy<WorldCanvasStroke> for WorldCanvasStrokeStrategy {
    async fn plan_move(
        &mut self,
        state: &StrokeCanvasState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<StrokePaintMove> {
        let recent = recent_cells_by(&state.cells, seat);
        let (mut gx, mut gy, mut dx, mut dy) = if let Some(first) = recent.first() {
            let (dx, dy) = if recent.len() == 2 {
                (
                    clamp_step(first.gx - recent[1].gx),
                    clamp_step(first.gy - recent[1].gy),
                )
            } else {
                (
                    (self.next_f64() * 3.0).floor() as i64 - 1,
                    (self.next_f64() * 3.0).floor() as i64 - 1,
                )
            };
            (first.gx, first.gy, dx, dy)
        } else {
            (
                if seat == Seat::A { 0 } else { 70 } + (self.next_f64() * 60.0).floor() as i64,
                (self.next_f64() * 90.0).floor() as i64,
                1,
                0,
            )
        };

        let mut seq = match seat {
            Seat::A => state.applied_seq_a,
            Seat::B => state.applied_seq_b,
        };
        let mut cells = Vec::with_capacity(8);
        for _ in 0..8 {
            if self.next_f64() < 0.35 {
                dx += (self.next_f64() * 3.0).floor() as i64 - 1;
                dy += (self.next_f64() * 3.0).floor() as i64 - 1;
            }
            dx = clamp_step(dx);
            dy = clamp_step(dy);
            if dx == 0 && dy == 0 {
                dx = 1;
            }
            gx += dx;
            gy += dy;
            seq += 1;
            cells.push(to_cell_move(gx, gy, 13, seq));
        }
        Some(StrokePaintMove {
            cells: cells.into_iter().take(MAX_BATCH_CELLS).collect(),
        })
    }
}

fn recent_cells_by(cells: &[RenderCell], seat: Seat) -> Vec<RenderCell> {
    let mut out = Vec::new();
    for cell in cells.iter().rev() {
        if cell.by == seat {
            out.push(cell.clone());
            if out.len() == 2 {
                break;
            }
        }
    }
    out
}

fn to_cell_move(gx: i64, gy: i64, color: u64, seq: u64) -> StrokeCellMove {
    let cx = gx.div_euclid(CHUNK_SIZE as i64);
    let cy = gy.div_euclid(CHUNK_SIZE as i64);
    StrokeCellMove {
        cx,
        cy,
        x: (gx - cx * CHUNK_SIZE as i64) as u64,
        y: (gy - cy * CHUNK_SIZE as i64) as u64,
        color: color.min(NUM_COLORS - 1),
        seq,
    }
}

fn clamp_step(delta: i64) -> i64 {
    delta.clamp(-2, 2)
}

fn splitmix_next(state: u64) -> u64 {
    let mut z = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}
