use crate::{
    mark_for, Caro, CaroMove, CaroSeries, CaroSeriesState, CaroState, DRAW, EMPTY, MARK_A, MARK_B,
};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Protocol, ProtocolError, Seat};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaroStrength {
    Strong,
    Weak,
}

#[derive(Clone, Copy, Debug)]
pub struct CaroStrategy {
    strength: CaroStrength,
    /// Immutable per-bot seed used only for salt derivation, never consumed by pick_cell.
    fast_seed: u64,
    rng_state: u64,
}

impl CaroStrategy {
    pub fn new(size: usize) -> Result<Self, ProtocolError> {
        Self::with_seed(size, CaroStrength::Strong, 0)
    }

    pub fn with_seed(
        size: usize,
        strength: CaroStrength,
        seed: u64,
    ) -> Result<Self, ProtocolError> {
        Caro::new(size, 0)?;
        Ok(Self {
            strength,
            fast_seed: seed,
            rng_state: seed,
        })
    }

    fn next_f64(&mut self) -> f64 {
        self.rng_state = splitmix_next(self.rng_state);
        (self.rng_state >> 11) as f64 / (1u64 << 53) as f64
    }

    fn pick_cell(&mut self, state: &CaroState, seat: Seat) -> Option<i64> {
        if state.winner != EMPTY || state.winner == DRAW || seat != state.turn {
            return None;
        }
        if state.moves_count == 0 {
            return Some((state.size * state.size / 2) as i64);
        }

        let me = mark_for(seat);
        let opp = if me == MARK_A { MARK_B } else { MARK_A };
        let radius = match self.strength {
            CaroStrength::Strong => 2,
            CaroStrength::Weak => 1,
        };
        let defense_weight = match self.strength {
            CaroStrength::Strong => 0.95,
            CaroStrength::Weak => 0.85,
        };
        let mut cells = candidates(&state.board, state.size, radius);
        if cells.is_empty() {
            cells = state
                .board
                .iter()
                .enumerate()
                .filter_map(|(idx, &cell)| (cell == EMPTY).then_some(idx))
                .collect();
        }

        let mut best_cell = *cells.first()?;
        let mut best_score = f64::NEG_INFINITY;
        for idx in cells {
            let score = move_score(&state.board, state.size, idx, me) as f64
                + defense_weight * move_score(&state.board, state.size, idx, opp) as f64;
            let jittered = score + self.next_f64() * 0.5;
            if jittered > best_score {
                best_score = jittered;
                best_cell = idx;
            }
        }
        Some(best_cell as i64)
    }
}

impl Default for CaroStrategy {
    fn default() -> Self {
        Self::new(15).expect("default caro strategy is valid")
    }
}

impl MoveStrategy<Caro> for CaroStrategy {
    async fn plan_move(
        &mut self,
        state: &CaroState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<CaroMove> {
        self.pick_cell(state, seat).map(|cell| {
            // Derive the salt from the immutable fast_seed (never from rng_state, which
            // pick_cell has already advanced). This keeps plan_move idempotent: the same
            // state always produces the same salt regardless of how many times it is called.
            let salt = derive_salt(self.fast_seed, state.moves_count);
            CaroMove { cell, salt }
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CaroSeriesStrategy {
    protocol: CaroSeries,
    inner: CaroStrategy,
}

impl CaroSeriesStrategy {
    pub fn new(max_games: u64, size: usize) -> Result<Self, ProtocolError> {
        Self::with_seed(max_games, size, CaroStrength::Strong, 0)
    }

    pub fn with_seed(
        max_games: u64,
        size: usize,
        strength: CaroStrength,
        seed: u64,
    ) -> Result<Self, ProtocolError> {
        Ok(Self {
            protocol: CaroSeries::new(max_games, size, 0)?,
            inner: CaroStrategy::with_seed(size, strength, seed)?,
        })
    }
}

impl MoveStrategy<CaroSeries> for CaroSeriesStrategy {
    async fn plan_move(
        &mut self,
        state: &CaroSeriesState,
        seat: Seat,
        ctx: &MoveStrategyContext,
    ) -> Option<CaroMove> {
        if self.protocol.is_terminal(state) {
            return None;
        }
        if state.inner.winner != EMPTY {
            return (seat == Seat::A).then_some(CaroMove {
                cell: 0,
                salt: derive_salt(self.inner.fast_seed, state.inner.moves_count),
            });
        }
        self.inner.plan_move(&state.inner, seat, ctx).await
    }
}

fn line_info(board: &[u8], size: usize, idx: usize, dr: i32, dc: i32, mark: u8) -> (usize, usize) {
    let row0 = (idx / size) as i32;
    let col0 = (idx % size) as i32;
    let mut run = 1;
    let mut row = row0 + dr;
    let mut col = col0 + dc;
    while in_bounds(size, row, col) && board[row as usize * size + col as usize] == mark {
        run += 1;
        row += dr;
        col += dc;
    }
    let fwd_open = in_bounds(size, row, col) && board[row as usize * size + col as usize] == EMPTY;
    row = row0 - dr;
    col = col0 - dc;
    while in_bounds(size, row, col) && board[row as usize * size + col as usize] == mark {
        run += 1;
        row -= dr;
        col -= dc;
    }
    let bwd_open = in_bounds(size, row, col) && board[row as usize * size + col as usize] == EMPTY;
    (run, usize::from(fwd_open) + usize::from(bwd_open))
}

fn pattern_value(run: usize, open_ends: usize) -> u32 {
    match (run, open_ends) {
        (5.., _) => 100_000,
        (4, 1..) => 9_000,
        (4, _) => 200,
        (3, 2) => 1_500,
        (3, _) => 150,
        (2, 2) => 200,
        (2, _) => 30,
        (_, 2) => 20,
        _ => 5,
    }
}

fn move_score(board: &[u8], size: usize, idx: usize, mark: u8) -> u32 {
    let mut best = 0;
    for (dr, dc) in [(0, 1), (1, 0), (1, 1), (1, -1)] {
        let (run, open_ends) = line_info(board, size, idx, dr, dc, mark);
        best = best.max(pattern_value(run, open_ends));
    }
    best
}

fn candidates(board: &[u8], size: usize, radius: i32) -> Vec<usize> {
    let mut out = Vec::new();
    for idx in 0..board.len() {
        if board[idx] != EMPTY {
            continue;
        }
        let row0 = (idx / size) as i32;
        let col0 = (idx % size) as i32;
        let mut near = false;
        for dr in -radius..=radius {
            for dc in -radius..=radius {
                if dr == 0 && dc == 0 {
                    continue;
                }
                let row = row0 + dr;
                let col = col0 + dc;
                if in_bounds(size, row, col) && board[row as usize * size + col as usize] != EMPTY {
                    near = true;
                    break;
                }
            }
            if near {
                break;
            }
        }
        if near {
            out.push(idx);
        }
    }
    out
}

fn in_bounds(size: usize, row: i32, col: i32) -> bool {
    row >= 0 && row < size as i32 && col >= 0 && col < size as i32
}

/// Derive a deterministic 16-byte salt from an immutable seed and the move index.
///
/// The seed must never be mutated (use `fast_seed`, not `rng_state`) so that
/// the same state always yields the same salt regardless of replay count.
fn derive_salt(seed: u64, moves_count: usize) -> Vec<u8> {
    let mut salt = [0u8; 16];
    salt[..8].copy_from_slice(&seed.to_be_bytes());
    salt[8] = (moves_count & 0xFF) as u8;
    salt[9] = ((moves_count >> 8) & 0xFF) as u8;
    // Fill remaining bytes with an expansion of the seed.
    for i in 10..16 {
        salt[i] = salt[i - 8] ^ (i as u8);
    }
    salt.to_vec()
}

fn splitmix_next(state: u64) -> u64 {
    let mut z = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}
