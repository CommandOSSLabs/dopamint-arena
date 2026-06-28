//! Bomb It protocol, ported from `sui-tunnel-ts/src/protocol/bombIt.ts`.

use std::collections::HashSet;

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub const GRID_W: i64 = 21;
pub const GRID_H: i64 = 21;
pub const CELL_COUNT: usize = (GRID_W * GRID_H) as usize;

pub const CELL_FLOOR: u8 = 0;
pub const CELL_WALL: u8 = 1;
pub const CELL_CRATE: u8 = 2;

pub const FUSE_TICKS: i64 = 8;
pub const BLAST_RADIUS: i64 = 2;
pub const MAX_BOMBS_PER_PLAYER: usize = 1;
pub const CRATE_DENSITY: f64 = 0.35;
pub const BOMB_IT_TICK_CAP: u64 = 5400;
pub const BOMB_IT_MIN_STAKE: u64 = 100;

pub const SPAWN_A: BombItCoord = BombItCoord { row: 1, col: 1 };
pub const SPAWN_B: BombItCoord = BombItCoord {
    row: GRID_H - 2,
    col: GRID_W - 2,
};

const DOMAIN: &[u8] = b"sui_tunnel::proto::bomb_it.v1";
const SERIES_DOMAIN: &[u8] = b"sui_tunnel::proto::bomb_it.series.v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BombItCoord {
    pub row: i64,
    pub col: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BombItAction {
    North,
    South,
    East,
    West,
    Bomb,
    Stay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BombItPlayer {
    pub row: i64,
    pub col: i64,
    pub alive: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BombItBomb {
    pub row: i64,
    pub col: i64,
    pub fuse: i64,
    pub owner: Seat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BombItWinner {
    A,
    B,
    Draw,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BombItState {
    pub tick: u64,
    pub seed: u64,
    pub grid: Vec<u8>,
    pub players: [BombItPlayer; 2],
    pub bombs: Vec<BombItBomb>,
    pub winner: Option<BombItWinner>,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BombItMove {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub a: Option<BombItAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub b: Option<BombItAction>,
}

impl BombItMove {
    pub fn stay_for(seat: Seat) -> Self {
        match seat {
            Seat::A => BombItMove {
                a: Some(BombItAction::Stay),
                b: None,
            },
            Seat::B => BombItMove {
                a: None,
                b: Some(BombItAction::Stay),
            },
        }
    }
}

pub struct ExplosionResolution {
    pub cells: HashSet<usize>,
    pub remaining: Vec<BombItBomb>,
}

#[derive(Clone, Copy)]
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Mulberry32 { state: seed }
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut t = (self.state ^ (self.state >> 15)).wrapping_mul(1 | self.state);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

pub fn idx(row: i64, col: i64) -> usize {
    (row * GRID_W + col) as usize
}

pub fn is_border(row: i64, col: i64) -> bool {
    row == 0 || row == GRID_H - 1 || col == 0 || col == GRID_W - 1
}

pub fn is_pillar(row: i64, col: i64) -> bool {
    row % 2 == 0 && col % 2 == 0
}

fn in_spawn_safe(row: i64, col: i64) -> bool {
    let br = GRID_H - 2;
    let bc = GRID_W - 2;
    let a = row == 1 && (col == 1 || col == 2) || (row == 2 && col == 1);
    let b = row == br && (col == bc || col == bc - 1) || (row == br - 1 && col == bc);
    a || b
}

pub fn build_grid(seed: u64) -> Vec<u8> {
    let mut grid = vec![CELL_FLOOR; CELL_COUNT];
    for row in 0..GRID_H {
        for col in 0..GRID_W {
            if is_border(row, col) || is_pillar(row, col) {
                grid[idx(row, col)] = CELL_WALL;
            }
        }
    }

    let mut rng = Mulberry32::new((seed & 0xffff_ffff) as u32);
    for row in 0..GRID_H {
        for col in 0..GRID_W {
            let i = idx(row, col);
            let mirror = idx(GRID_H - 1 - row, GRID_W - 1 - col);
            if i >= mirror || grid[i] != CELL_FLOOR {
                continue;
            }
            if in_spawn_safe(row, col) || in_spawn_safe(GRID_H - 1 - row, GRID_W - 1 - col) {
                continue;
            }
            if rng.next() < CRATE_DENSITY {
                grid[i] = CELL_CRATE;
                grid[mirror] = CELL_CRATE;
            }
        }
    }
    grid
}

pub fn dest(row: i64, col: i64, action: BombItAction) -> (i64, i64) {
    match action {
        BombItAction::North => (row - 1, col),
        BombItAction::South => (row + 1, col),
        BombItAction::East => (row, col + 1),
        BombItAction::West => (row, col - 1),
        BombItAction::Bomb | BombItAction::Stay => (row, col),
    }
}

pub fn can_move_to(
    grid: &[u8],
    bombs: &[BombItBomb],
    other: &BombItPlayer,
    row: i64,
    col: i64,
) -> bool {
    if !(0..GRID_H).contains(&row) || !(0..GRID_W).contains(&col) {
        return false;
    }
    let cell = grid[idx(row, col)];
    if cell == CELL_WALL || cell == CELL_CRATE {
        return false;
    }
    if bombs.iter().any(|b| b.row == row && b.col == col) {
        return false;
    }
    if other.alive && other.row == row && other.col == col {
        return false;
    }
    true
}

pub fn blast_cells_for(grid: &[u8], bomb: &BombItBomb) -> Vec<usize> {
    let mut out = vec![idx(bomb.row, bomb.col)];
    let dirs = [(-1, 0), (1, 0), (0, 1), (0, -1)];
    for (dr, dc) in dirs {
        for step in 1..=BLAST_RADIUS {
            let row = bomb.row + dr * step;
            let col = bomb.col + dc * step;
            if !(0..GRID_H).contains(&row) || !(0..GRID_W).contains(&col) {
                break;
            }
            let cell = grid[idx(row, col)];
            if cell == CELL_WALL {
                break;
            }
            out.push(idx(row, col));
            if cell == CELL_CRATE {
                break;
            }
        }
    }
    out
}

pub fn resolve_explosions(grid: &mut [u8], bombs: Vec<BombItBomb>) -> ExplosionResolution {
    let mut detonating = HashSet::new();
    for (i, bomb) in bombs.iter().enumerate() {
        if bomb.fuse <= 0 {
            detonating.insert(i);
        }
    }

    let mut cells = HashSet::new();
    let mut changed = true;
    while changed {
        changed = false;
        cells.clear();
        for &i in &detonating {
            for cell in blast_cells_for(grid, &bombs[i]) {
                cells.insert(cell);
            }
        }
        for (i, bomb) in bombs.iter().enumerate() {
            if !detonating.contains(&i) && cells.contains(&idx(bomb.row, bomb.col)) {
                detonating.insert(i);
                changed = true;
            }
        }
    }

    for &cell in &cells {
        if grid[cell] == CELL_CRATE {
            grid[cell] = CELL_FLOOR;
        }
    }
    let remaining = bombs
        .into_iter()
        .enumerate()
        .filter_map(|(i, bomb)| (!detonating.contains(&i)).then_some(bomb))
        .collect();
    ExplosionResolution { cells, remaining }
}

fn seed_from_tunnel_id(tunnel_id: &str) -> u64 {
    let mut h: u32 = 2_166_136_261;
    for b in tunnel_id.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16_777_619);
    }
    h as u64
}

fn spawn(row: i64, col: i64) -> BombItPlayer {
    BombItPlayer {
        row,
        col,
        alive: true,
    }
}

fn apply_action(
    grid: &[u8],
    players: &mut [BombItPlayer; 2],
    bombs: &mut Vec<BombItBomb>,
    index: usize,
    action: BombItAction,
) {
    let player = players[index];
    if !player.alive || action == BombItAction::Stay {
        return;
    }
    let owner = if index == 0 { Seat::A } else { Seat::B };
    if action == BombItAction::Bomb {
        let live = bombs.iter().filter(|b| b.owner == owner).count();
        let here = bombs
            .iter()
            .any(|b| b.row == player.row && b.col == player.col);
        if live < MAX_BOMBS_PER_PLAYER && !here {
            bombs.push(BombItBomb {
                row: player.row,
                col: player.col,
                fuse: FUSE_TICKS,
                owner,
            });
        }
        return;
    }
    let (row, col) = dest(player.row, player.col, action);
    if can_move_to(
        grid,
        bombs,
        &players[if index == 0 { 1 } else { 0 }],
        row,
        col,
    ) {
        players[index].row = row;
        players[index].col = col;
    }
}

fn simple_action(state: &BombItState, seat: Seat, rng: &mut dyn FnMut() -> f64) -> BombItAction {
    let index = if seat == Seat::A { 0 } else { 1 };
    let player = state.players[index];
    if !player.alive {
        return BombItAction::Stay;
    }
    let other = state.players[if index == 0 { 1 } else { 0 }];
    let dirs = [
        BombItAction::North,
        BombItAction::South,
        BombItAction::East,
        BombItAction::West,
    ];
    let legal: Vec<_> = dirs
        .into_iter()
        .filter(|&action| {
            let (row, col) = dest(player.row, player.col, action);
            can_move_to(&state.grid, &state.bombs, &other, row, col)
        })
        .collect();
    let live_own = state.bombs.iter().filter(|b| b.owner == seat).count();
    let here = state
        .bombs
        .iter()
        .any(|b| b.row == player.row && b.col == player.col);
    if live_own < MAX_BOMBS_PER_PLAYER && !here && rng() < 0.05 {
        return BombItAction::Bomb;
    }
    if legal.is_empty() {
        BombItAction::Stay
    } else {
        let idx = ((rng() * legal.len() as f64).floor() as usize).min(legal.len() - 1);
        legal[idx]
    }
}

#[derive(Clone, Copy, Debug)]
pub struct BombIt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BombItSeriesState {
    pub inner: BombItState,
    pub games_played: u64,
    pub balance_a: u64,
    pub balance_b: u64,
}

#[derive(Clone, Debug)]
pub struct BombItSeries {
    tunnel_id: String,
    stake_per_game: u64,
    inner: BombIt,
}

impl BombItSeries {
    pub fn new(tunnel_id: impl Into<String>, stake_per_game: u64) -> Self {
        Self {
            tunnel_id: tunnel_id.into(),
            stake_per_game,
            inner: BombIt,
        }
    }

    fn game_ctx(&self, game_number: u64) -> TunnelContext {
        TunnelContext {
            tunnel_id: format!("{}:g{}", self.tunnel_id, game_number),
            initial: Balances {
                a: self.stake_per_game,
                b: self.stake_per_game,
            },
            seat: Seat::A,
        }
    }

    fn can_fund_next_game(&self, state: &BombItSeriesState) -> bool {
        self.stake_per_game == 0
            || (state.balance_a >= self.stake_per_game && state.balance_b >= self.stake_per_game)
    }

    fn swap(&self, balance_a: u64, balance_b: u64, winner: Option<BombItWinner>) -> (u64, u64) {
        match winner {
            Some(BombItWinner::A) => {
                let stake = self.stake_per_game.min(balance_b);
                (balance_a + stake, balance_b - stake)
            }
            Some(BombItWinner::B) => {
                let stake = self.stake_per_game.min(balance_a);
                (balance_a - stake, balance_b + stake)
            }
            Some(BombItWinner::Draw) | None => (balance_a, balance_b),
        }
    }
}

impl Protocol for BombIt {
    type State = BombItState;
    type Move = BombItMove;

    fn name(&self) -> &str {
        "bomb_it.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> BombItState {
        let seed = seed_from_tunnel_id(&ctx.tunnel_id);
        BombItState {
            tick: 0,
            seed,
            grid: build_grid(seed),
            players: [
                spawn(SPAWN_A.row, SPAWN_A.col),
                spawn(SPAWN_B.row, SPAWN_B.col),
            ],
            bombs: Vec::new(),
            winner: None,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            total: ctx.initial.sum(),
        }
    }

    fn apply_move(
        &self,
        state: &BombItState,
        mv: &BombItMove,
        by: Seat,
    ) -> Result<BombItState, ProtocolError> {
        if self.is_terminal(state) {
            return Err(ProtocolError(
                "game over: bomb-it is already decided".into(),
            ));
        }
        if by == Seat::A && mv.b.is_some() {
            return Err(ProtocolError("A cannot submit B's action".into()));
        }
        if by == Seat::B && mv.a.is_some() {
            return Err(ProtocolError("B cannot submit A's action".into()));
        }

        let mut grid = state.grid.clone();
        let mut players = state.players;
        let mut bombs = state.bombs.clone();

        apply_action(
            &grid,
            &mut players,
            &mut bombs,
            0,
            mv.a.unwrap_or(BombItAction::Stay),
        );
        apply_action(
            &grid,
            &mut players,
            &mut bombs,
            1,
            mv.b.unwrap_or(BombItAction::Stay),
        );

        for bomb in &mut bombs {
            bomb.fuse -= 1;
        }
        let resolved = resolve_explosions(&mut grid, bombs);
        bombs = resolved.remaining;
        for player in &mut players {
            if player.alive && resolved.cells.contains(&idx(player.row, player.col)) {
                player.alive = false;
            }
        }

        let tick = state.tick + 1;
        let winner = match (players[0].alive, players[1].alive) {
            (false, false) => Some(BombItWinner::Draw),
            (true, false) => Some(BombItWinner::A),
            (false, true) => Some(BombItWinner::B),
            (true, true) if tick >= BOMB_IT_TICK_CAP => Some(BombItWinner::Draw),
            _ => None,
        };
        let (balance_a, balance_b) = match winner {
            Some(BombItWinner::A) => (state.total, 0),
            Some(BombItWinner::B) => (0, state.total),
            Some(BombItWinner::Draw) | None => (state.balance_a, state.balance_b),
        };

        Ok(BombItState {
            tick,
            seed: state.seed,
            grid,
            players,
            bombs,
            winner,
            balance_a,
            balance_b,
            total: state.total,
        })
    }

    fn encode_state(&self, state: &BombItState) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&u64_to_be_bytes(state.tick));
        out.extend_from_slice(&u64_to_be_bytes(state.seed));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_a));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_b));
        out.extend_from_slice(&state.grid);
        for player in &state.players {
            out.extend_from_slice(&u64_to_be_bytes(player.row as u64));
            out.extend_from_slice(&u64_to_be_bytes(player.col as u64));
            out.push(if player.alive { 1 } else { 0 });
        }
        for (slot, owner) in [Seat::A, Seat::B].into_iter().enumerate() {
            let bomb = state.bombs.iter().find(|b| b.owner == owner);
            out.push(if bomb.is_some() { 1 } else { 0 });
            out.extend_from_slice(&u64_to_be_bytes(bomb.map(|b| b.row as u64).unwrap_or(0)));
            out.extend_from_slice(&u64_to_be_bytes(bomb.map(|b| b.col as u64).unwrap_or(0)));
            out.extend_from_slice(&u64_to_be_bytes(bomb.map(|b| b.fuse as u64).unwrap_or(0)));
            out.push(slot as u8);
        }
        out.push(match state.winner {
            Some(BombItWinner::A) => 1,
            Some(BombItWinner::B) => 2,
            Some(BombItWinner::Draw) => 3,
            None => 0,
        });
        out
    }

    fn balances(&self, state: &BombItState) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &BombItState) -> bool {
        state.winner.is_some()
    }

    fn sample_move(
        &self,
        state: &BombItState,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<BombItMove> {
        if self.is_terminal(state) {
            return None;
        }
        let action = simple_action(state, seat, rng);
        Some(match seat {
            Seat::A => BombItMove {
                a: Some(action),
                b: None,
            },
            Seat::B => BombItMove {
                a: None,
                b: Some(action),
            },
        })
    }
}

fn push_length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u64_to_be_bytes(bytes.len() as u64));
    out.extend_from_slice(bytes);
}

impl Protocol for BombItSeries {
    type State = BombItSeriesState;
    type Move = BombItMove;

    fn name(&self) -> &str {
        "bomb_it.series.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        BombItSeriesState {
            inner: self.inner.initial_state(&self.game_ctx(1)),
            games_played: 0,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
        }
    }

    fn apply_move(
        &self,
        state: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, ProtocolError> {
        if !self.inner.is_terminal(&state.inner) {
            let next_inner = self.inner.apply_move(&state.inner, mv, by)?;
            if self.inner.is_terminal(&next_inner) {
                let (balance_a, balance_b) =
                    self.swap(state.balance_a, state.balance_b, next_inner.winner);
                return Ok(BombItSeriesState {
                    inner: next_inner,
                    games_played: state.games_played,
                    balance_a,
                    balance_b,
                });
            }
            return Ok(BombItSeriesState {
                inner: next_inner,
                ..state.clone()
            });
        }
        if self.is_terminal(state) {
            return Err(ProtocolError(
                "session over: insufficient balance for another game".into(),
            ));
        }
        let fresh = self
            .inner
            .initial_state(&self.game_ctx(state.games_played + 2));
        Ok(BombItSeriesState {
            inner: self.inner.apply_move(&fresh, mv, by)?,
            games_played: state.games_played + 1,
            balance_a: state.balance_a,
            balance_b: state.balance_b,
        })
    }

    fn encode_state(&self, state: &Self::State) -> Vec<u8> {
        let inner = self.inner.encode_state(&state.inner);
        let mut body = Vec::new();
        push_length_prefixed(&mut body, &inner);
        push_length_prefixed(&mut body, &u64_to_be_bytes(state.games_played));
        push_length_prefixed(&mut body, &u64_to_be_bytes(state.balance_a));
        push_length_prefixed(&mut body, &u64_to_be_bytes(state.balance_b));
        let mut out = Vec::with_capacity(SERIES_DOMAIN.len() + body.len());
        out.extend_from_slice(SERIES_DOMAIN);
        out.extend_from_slice(&body);
        out
    }

    fn balances(&self, state: &Self::State) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &Self::State) -> bool {
        self.inner.is_terminal(&state.inner) && !self.can_fund_next_game(state)
    }

    fn sample_move(
        &self,
        state: &Self::State,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        if self.inner.is_terminal(&state.inner) {
            return None;
        }
        self.inner.sample_move(&state.inner, seat, rng)
    }
}
