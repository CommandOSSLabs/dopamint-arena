use crate::{
    commit_board, commitment_root, prove_cell, shots_at, splitmix_next, Battleship, BattleshipMove,
    BattleshipPhase, BattleshipSeries, BattleshipSeriesState, BattleshipState, BattleshipWinner,
    BOARD_SIZE, CELL_COUNT, FLEET_CELLS,
};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Seat};

const ORTHO: [(i32, i32); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];

#[derive(Clone, Debug)]
pub struct BattleshipStrategy {
    board: Vec<u8>,
    salts: Vec<[u8; 32]>,
    layers: Vec<Vec<[u8; 32]>>,
    rng_state: u64,
}

impl BattleshipStrategy {
    pub fn new(seed: u64) -> Self {
        let mut rng_state = seed;
        let mut board = vec![0u8; CELL_COUNT];
        for cell in board.iter_mut().take(FLEET_CELLS as usize) {
            *cell = 1;
        }
        let salts: Vec<[u8; 32]> = (0..CELL_COUNT)
            .map(|_| {
                let mut salt = [0u8; 32];
                for byte in &mut salt {
                    rng_state = splitmix_next(rng_state);
                    *byte = (rng_state >> 56) as u8;
                }
                salt
            })
            .collect();
        let layers = commit_board(&board, &salts).expect("bench fleet is well-formed");
        Self {
            board,
            salts,
            layers,
            rng_state,
        }
    }

    fn next_f64(&mut self) -> f64 {
        self.rng_state = splitmix_next(self.rng_state);
        (self.rng_state >> 11) as f64 / (1u64 << 53) as f64
    }

    fn commit_move(&self) -> Option<BattleshipMove> {
        Some(BattleshipMove::Commit {
            root: commitment_root(&self.layers)?,
        })
    }

    fn reveal_move(&self, cell: u8) -> Option<BattleshipMove> {
        let idx = cell as usize;
        Some(BattleshipMove::Reveal {
            cell,
            is_ship: self.board.get(idx).copied()? == 1,
            salt: *self.salts.get(idx)?,
            proof: prove_cell(&self.layers, cell).ok()?,
        })
    }

    fn shoot_move(&mut self, state: &BattleshipState, seat: Seat) -> Option<BattleshipMove> {
        pick_shot(state, seat, || self.next_f64()).map(|cell| BattleshipMove::Shoot { cell })
    }
}

impl MoveStrategy<Battleship> for BattleshipStrategy {
    async fn plan_move(
        &mut self,
        state: &BattleshipState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<BattleshipMove> {
        match state.phase {
            BattleshipPhase::AwaitingCommits => {
                let owes_commit = (state.commit_a.is_none() && seat == Seat::A)
                    || (state.commit_a.is_some() && state.commit_b.is_none() && seat == Seat::B);
                if owes_commit {
                    self.commit_move()
                } else {
                    None
                }
            }
            BattleshipPhase::Playing => {
                if let Some(pending) = state.pending_shot {
                    return (pending.by != seat).then(|| self.reveal_move(pending.cell))?;
                }
                (state.turn == seat)
                    .then(|| self.shoot_move(state, seat))
                    .flatten()
            }
            BattleshipPhase::Over => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BattleshipSeriesStrategy {
    seed: u64,
    stake_per_game: u64,
    game_index: u64,
    inner: BattleshipStrategy,
}

impl BattleshipSeriesStrategy {
    pub fn new(seed: u64, stake_per_game: u64) -> Self {
        Self {
            seed,
            stake_per_game,
            game_index: 0,
            inner: BattleshipStrategy::new(seed_for_game(seed, 0)),
        }
    }

    fn use_game(&mut self, game_index: u64) {
        if self.game_index != game_index {
            self.game_index = game_index;
            self.inner = BattleshipStrategy::new(seed_for_game(self.seed, game_index));
        }
    }
}

impl MoveStrategy<BattleshipSeries> for BattleshipSeriesStrategy {
    async fn plan_move(
        &mut self,
        state: &BattleshipSeriesState,
        seat: Seat,
        ctx: &MoveStrategyContext,
    ) -> Option<BattleshipMove> {
        if state.inner.winner == BattleshipWinner::None {
            self.use_game(state.games_played);
            return self.inner.plan_move(&state.inner, seat, ctx).await;
        }
        let can_continue = self.stake_per_game == 0
            || (state.balance_a >= self.stake_per_game && state.balance_b >= self.stake_per_game);
        if !can_continue || seat != Seat::A {
            return None;
        }
        self.use_game(state.games_played + 1);
        self.inner.commit_move()
    }
}

fn seed_for_game(seed: u64, game_index: u64) -> u64 {
    splitmix_next(seed ^ game_index.wrapping_mul(0xD1B5_4A32_D192_ED03))
}

fn pick_shot(state: &BattleshipState, shooter: Seat, mut rng: impl FnMut() -> f64) -> Option<u8> {
    let defender = shooter.other();
    let shots = shots_at(state, defender);
    let fired: std::collections::BTreeSet<u8> = shots.iter().map(|s| s.cell).collect();
    let hits: std::collections::BTreeSet<u8> = shots
        .iter()
        .filter_map(|s| s.is_hit.then_some(s.cell))
        .collect();

    if !hits.is_empty() {
        let line_targets = line_extensions(&hits, &fired);
        if !line_targets.is_empty() {
            return pick_from(&line_targets, &mut rng);
        }
        let neighbours: Vec<u8> = hits
            .iter()
            .flat_map(|&cell| ortho_neighbors(cell))
            .filter(|cell| !fired.contains(cell))
            .collect();
        if !neighbours.is_empty() {
            return pick_from(&neighbours, &mut rng);
        }
    }

    let open: Vec<u8> = (0..CELL_COUNT as u8)
        .filter(|cell| !fired.contains(cell))
        .collect();
    if open.is_empty() {
        return None;
    }
    let parity: Vec<u8> = open
        .iter()
        .copied()
        .filter(|&cell| (row_of(cell) + col_of(cell)) % 2 == 0)
        .collect();
    if parity.is_empty() {
        pick_from(&open, &mut rng)
    } else {
        pick_from(&parity, &mut rng)
    }
}

fn pick_from(pool: &[u8], rng: &mut impl FnMut() -> f64) -> Option<u8> {
    if pool.is_empty() {
        return None;
    }
    let idx = ((rng() * pool.len() as f64).floor() as usize).min(pool.len() - 1);
    Some(pool[idx])
}

fn row_of(cell: u8) -> i32 {
    cell as i32 / BOARD_SIZE as i32
}

fn col_of(cell: u8) -> i32 {
    cell as i32 % BOARD_SIZE as i32
}

fn cell_at(row: i32, col: i32) -> Option<u8> {
    (row >= 0 && row < BOARD_SIZE as i32 && col >= 0 && col < BOARD_SIZE as i32)
        .then_some((row * BOARD_SIZE as i32 + col) as u8)
}

fn ortho_neighbors(cell: u8) -> Vec<u8> {
    let row = row_of(cell);
    let col = col_of(cell);
    ORTHO
        .iter()
        .filter_map(|(dr, dc)| cell_at(row + dr, col + dc))
        .collect()
}

fn line_extensions(
    hits: &std::collections::BTreeSet<u8>,
    fired: &std::collections::BTreeSet<u8>,
) -> Vec<u8> {
    let mut out = Vec::new();
    for &hit in hits {
        let row = row_of(hit);
        let col = col_of(hit);
        for (dr, dc) in ORTHO {
            let Some(next) = cell_at(row + dr, col + dc) else {
                continue;
            };
            if !hits.contains(&next) {
                continue;
            }
            let mut end_row = row + dr;
            let mut end_col = col + dc;
            while let Some(cell) = cell_at(end_row + dr, end_col + dc) {
                if !hits.contains(&cell) {
                    break;
                }
                end_row += dr;
                end_col += dc;
            }
            if let Some(cell) = cell_at(end_row + dr, end_col + dc) {
                if !fired.contains(&cell) {
                    out.push(cell);
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}
