use crate::{
    mark_for, Caro, CaroMove, CaroSeries, CaroSeriesState, CaroState, DRAW, EMPTY, MARK_A, MARK_B,
};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Protocol, ProtocolError, Seat};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaroStrength {
    Strong,
    Weak,
    /// The easiest tier: ignores threats entirely (never blocks the human, never builds a
    /// coherent line) and plays a deterministic pseudo-random cell adjacent to existing stones.
    /// A focused human reliably wins. Used by the arena so casual players beat the bot.
    Easy,
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
            CaroStrength::Weak | CaroStrength::Easy => 1,
        };
        let defense_weight = match self.strength {
            CaroStrength::Strong => 0.95,
            CaroStrength::Weak | CaroStrength::Easy => 0.85,
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

        if self.strength == CaroStrength::Easy {
            // Skip all threat/offense scoring: pick a deterministic pseudo-random cell adjacent to
            // existing stones. The bot stays engaged near the action but never blocks the human or
            // builds a coherent line, so a focused human reliably wins. Idempotent — a pure
            // function of the immutable seed + board — so a replayed state yields the same move.
            if cells.is_empty() {
                return None;
            }
            let idx = fnv_index(self.fast_seed, &state.board, cells.len());
            return Some(cells[idx] as i64);
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

/// Run length plus its two ends. `open_ends` (empty neighbour, edge excluded) drives the
/// extension scoring; `opp_blocked_ends` (an opponent stone, edge excluded) decides whether a
/// five actually wins — matching `caro::winner_around`'s standard-caro rule.
fn line_info(
    board: &[u8],
    size: usize,
    idx: usize,
    dr: i32,
    dc: i32,
    mark: u8,
) -> (usize, usize, usize) {
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
    let fwd_opp = in_bounds(size, row, col) && board[row as usize * size + col as usize] != EMPTY;
    row = row0 - dr;
    col = col0 - dc;
    while in_bounds(size, row, col) && board[row as usize * size + col as usize] == mark {
        run += 1;
        row -= dr;
        col -= dc;
    }
    let bwd_open = in_bounds(size, row, col) && board[row as usize * size + col as usize] == EMPTY;
    let bwd_opp = in_bounds(size, row, col) && board[row as usize * size + col as usize] != EMPTY;
    (
        run,
        usize::from(fwd_open) + usize::from(bwd_open),
        usize::from(fwd_opp) + usize::from(bwd_opp),
    )
}

fn pattern_value(run: usize, open_ends: usize, opp_blocked_ends: usize) -> u32 {
    match run {
        // Standard caro: only an exactly-five not flanked by the opponent on both ends wins.
        5 if opp_blocked_ends < 2 => 100_000,
        5 => 200,          // dead five (both ends blocked) — no win
        n if n > 5 => 200, // overline — no win
        4 if open_ends >= 1 => 9_000,
        4 => 200,
        3 if open_ends == 2 => 1_500,
        3 => 150,
        2 if open_ends == 2 => 200,
        2 => 30,
        _ if open_ends == 2 => 20,
        _ => 5,
    }
}

fn move_score(board: &[u8], size: usize, idx: usize, mark: u8) -> u32 {
    let mut best = 0;
    for (dr, dc) in [(0, 1), (1, 0), (1, 1), (1, -1)] {
        let (run, open_ends, opp_blocked_ends) = line_info(board, size, idx, dr, dc, mark);
        best = best.max(pattern_value(run, open_ends, opp_blocked_ends));
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

/// Deterministic FNV-1a fold of (seed, board bytes) into `[0, n)`. Drives the `Easy` tier's
/// pseudo-random-but-idempotent cell pick; `n` must be non-zero.
fn fnv_index(seed: u64, board: &[u8], n: usize) -> usize {
    let mut h = seed ^ 0xcbf2_9ce4_8422_2325;
    for &byte in board {
        h = (h ^ byte as u64).wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h % n as u64) as usize
}

fn splitmix_next(state: u64) -> u64 {
    let mut z = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: usize = 15;

    fn at(row: usize, col: usize) -> usize {
        row * SIZE + col
    }

    /// B-to-move board with the given stones placed; balances/accumulator are irrelevant to
    /// cell selection.
    fn board_with(stones: &[(usize, u8)]) -> CaroState {
        let mut board = vec![EMPTY; SIZE * SIZE];
        for &(idx, mark) in stones {
            board[idx] = mark;
        }
        CaroState {
            board,
            size: SIZE,
            turn: Seat::B,
            winner: EMPTY,
            last_move: -1,
            moves_count: stones.len(),
            balance_a: 0,
            balance_b: 0,
            stake: 0,
            move_accumulator: [0u8; 32],
        }
    }

    /// The behavioral contract the arena relies on: a competent bot defends a forced win, but the
    /// `Easy` tier does not — so a human one move from five actually completes it. If `Easy` ever
    /// starts blocking again (e.g. reverted to the `Weak` scoring path), this fails.
    #[test]
    fn easy_does_not_block_a_forced_win_but_weak_does() {
        // A has four horizontally (row 7, cols 3..=6). B holds the low end (col 2), so the ONLY
        // cell completing A's (winning) five is the open end at col 7.
        let stones = [
            (at(7, 3), MARK_A),
            (at(7, 4), MARK_A),
            (at(7, 5), MARK_A),
            (at(7, 6), MARK_A),
            (at(7, 2), MARK_B),
        ];
        let win_cell = at(7, 7) as i64;

        let mut weak = CaroStrategy::with_seed(SIZE, CaroStrength::Weak, 0xB0B).unwrap();
        assert_eq!(
            weak.pick_cell(&board_with(&stones), Seat::B),
            Some(win_cell),
            "a competent bot must block the opponent's only winning cell",
        );

        let mut easy = CaroStrategy::with_seed(SIZE, CaroStrength::Easy, 0xB0B).unwrap();
        assert_ne!(
            easy.pick_cell(&board_with(&stones), Seat::B),
            Some(win_cell),
            "the easiest bot must not defend, so the human can complete their line",
        );
    }

    /// Play a full game to a decision by alternating each seat's `pick_cell`, placing the stone and
    /// checking the standard-caro win around it.
    fn play_to_winner(a: &mut CaroStrategy, b: &mut CaroStrategy) -> u8 {
        let mut state = board_with(&[]);
        state.turn = Seat::A;
        for _ in 0..(SIZE * SIZE) {
            let seat = state.turn;
            let strategy = if seat == Seat::A { &mut *a } else { &mut *b };
            let Some(cell) = strategy.pick_cell(&state, seat) else {
                break;
            };
            let idx = cell as usize;
            state.board[idx] = mark_for(seat);
            state.moves_count += 1;
            let winner = crate::winner_around(&state.board, SIZE, idx);
            if winner != EMPTY {
                return winner;
            }
            state.turn = if seat == Seat::A { Seat::B } else { Seat::A };
        }
        DRAW
    }

    /// The arena's guarantee: the human (seat A, moving first) beats the `Easy` bot (seat B) every
    /// time. Seeds are varied so this is not one lucky game. If `Easy` regains its defense/offense,
    /// the competent side would be contested and this fails.
    #[test]
    fn easy_bot_reliably_loses_to_a_competent_opponent() {
        for seed in [1u64, 42, 0xB0B, 7, 0xDEAD_BEEF] {
            let mut human = CaroStrategy::with_seed(SIZE, CaroStrength::Strong, seed).unwrap();
            let mut easy_bot = CaroStrategy::with_seed(SIZE, CaroStrength::Easy, seed).unwrap();
            assert_eq!(
                play_to_winner(&mut human, &mut easy_bot),
                MARK_A,
                "the competent seat-A player should beat the Easy bot (seed {seed:#x})",
            );
        }
    }
}
