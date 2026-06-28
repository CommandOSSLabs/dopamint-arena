//! Chicken Cross protocol, ported from `sui-tunnel-ts/src/protocol/cross.ts`.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub const COLUMN_COUNT: usize = 9;
pub const SPAWN_COL: usize = 4;
pub const WIN_LANE: i64 = 600;
pub const TICK_CAP: u64 = 5400;
pub const RESPAWN_INVULN: u64 = 3;
pub const MIN_STAKE: u64 = 100;

const DOMAIN: &[u8] = b"sui_tunnel::proto::cross.v1";
const SERIES_DOMAIN: &[u8] = b"sui_tunnel::proto::cross.series.v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CrossDir {
    North,
    South,
    East,
    West,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrossLaneKind {
    Grass,
    Road,
    Water,
    Rails,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HazardSpan {
    pub center: f64,
    pub half: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CrossPlayer {
    pub lane: i64,
    pub col: usize,
    pub score: i64,
    pub invuln_ticks: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossState {
    pub tick: u64,
    pub seed: u64,
    pub players: [CrossPlayer; 2],
    pub winner: Option<Seat>,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossMove {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir_a: Option<CrossDir>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir_b: Option<CrossDir>,
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

fn modulo(x: f64, m: f64) -> f64 {
    ((x % m) + m) % m
}

pub fn lane_kind(lane: i64) -> CrossLaneKind {
    if lane < 2 {
        return CrossLaneKind::Grass;
    }
    match (lane - 2).rem_euclid(6) {
        0 | 1 => CrossLaneKind::Road,
        2 => CrossLaneKind::Water,
        3 => CrossLaneKind::Rails,
        _ => CrossLaneKind::Grass,
    }
}

fn lane_rng(seed: u64, lane: i64) -> Mulberry32 {
    let mixed = (seed ^ ((lane as u64).wrapping_mul(0x9e37_79b1))) & 0xffff_ffff;
    Mulberry32::new(mixed as u32)
}

pub fn hazards_at(seed: u64, lane: i64, tick: u64) -> Vec<HazardSpan> {
    let kind = lane_kind(lane);
    if kind == CrossLaneKind::Grass {
        return Vec::new();
    }
    let mut rng = lane_rng(seed, lane);
    let t = (tick % 1_048_576) as f64;
    let mut spans = Vec::new();

    match kind {
        CrossLaneKind::Road => {
            let count = if rng.next() < 0.5 { 2 } else { 1 };
            for _ in 0..count {
                let speed = 0.1 + rng.next() * 0.1;
                let dir = if rng.next() < 0.5 { 1.0 } else { -1.0 };
                let phase = rng.next() * COLUMN_COUNT as f64;
                spans.push(HazardSpan {
                    center: modulo(phase + dir * speed * t, COLUMN_COUNT as f64),
                    half: 0.9,
                });
            }
        }
        CrossLaneKind::Water => {
            let count = if rng.next() < 0.5 { 2 } else { 1 };
            for i in 0..count {
                let speed = 0.06 + rng.next() * 0.05;
                let dir = if rng.next() < 0.5 { 1.0 } else { -1.0 };
                let phase = rng.next() * COLUMN_COUNT as f64 + i as f64 * 3.0;
                spans.push(HazardSpan {
                    center: modulo(phase + dir * speed * t, COLUMN_COUNT as f64),
                    half: 1.4,
                });
            }
        }
        CrossLaneKind::Rails => {
            let speed = 0.2 + rng.next() * 0.15;
            let dir = if rng.next() < 0.5 { 1.0 } else { -1.0 };
            let phase = rng.next() * COLUMN_COUNT as f64;
            spans.push(HazardSpan {
                center: modulo(phase + dir * speed * t, COLUMN_COUNT as f64),
                half: 3.0,
            });
        }
        CrossLaneKind::Grass => {}
    }

    spans
}

pub fn span_covers_col(span: &HazardSpan, col: usize) -> bool {
    let c = col as f64 + 0.5;
    [c, c - COLUMN_COUNT as f64, c + COLUMN_COUNT as f64]
        .iter()
        .any(|cc| *cc > span.center - span.half && *cc < span.center + span.half)
}

pub fn is_lethal(seed: u64, col: usize, lane: i64, tick: u64) -> bool {
    if lane < 0 {
        return true;
    }
    let kind = lane_kind(lane);
    if kind == CrossLaneKind::Grass {
        return false;
    }
    let on_hazard = hazards_at(seed, lane, tick)
        .iter()
        .any(|span| span_covers_col(span, col));
    if kind == CrossLaneKind::Water {
        !on_hazard
    } else {
        on_hazard
    }
}

pub fn dest_of(lane: i64, col: usize, dir: CrossDir) -> (i64, usize) {
    match dir {
        CrossDir::North => (lane + 1, col),
        CrossDir::South => (lane.saturating_sub(1).max(0), col),
        CrossDir::East => (lane, (col + 1).min(COLUMN_COUNT - 1)),
        CrossDir::West => (lane, col.saturating_sub(1)),
    }
}

fn spawn_player() -> CrossPlayer {
    CrossPlayer {
        lane: 0,
        col: SPAWN_COL,
        score: 0,
        invuln_ticks: 0,
    }
}

fn seed_from_tunnel_id(tunnel_id: &str) -> u64 {
    let mut h: u32 = 2_166_136_261;
    for b in tunnel_id.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(16_777_619);
    }
    h as u64
}

fn step_player(seed: u64, player: CrossPlayer, dir: Option<CrossDir>, tick: u64) -> CrossPlayer {
    if player.invuln_ticks > 0 {
        return CrossPlayer {
            invuln_ticks: player.invuln_ticks - 1,
            ..player
        };
    }

    let mut lane = player.lane;
    let mut col = player.col;
    if let Some(dir) = dir {
        let (next_lane, next_col) = dest_of(lane, col, dir);
        if !is_lethal(seed, next_col, next_lane, tick) {
            lane = next_lane;
            col = next_col;
        }
    }
    let score = player.score.max(lane);
    if is_lethal(seed, col, lane, tick) {
        return CrossPlayer {
            lane: 0,
            col: SPAWN_COL,
            score,
            invuln_ticks: RESPAWN_INVULN,
        };
    }
    CrossPlayer {
        lane,
        col,
        score,
        invuln_ticks: 0,
    }
}

fn greedy_dir(state: &CrossState, index: usize, rng: &mut dyn FnMut() -> f64) -> Option<CrossDir> {
    let player = state.players[index];
    if player.invuln_ticks > 0 {
        return None;
    }
    let tick = state.tick + 1;
    let near = if index == 0 {
        CrossDir::East
    } else {
        CrossDir::West
    };
    let far = if index == 0 {
        CrossDir::West
    } else {
        CrossDir::East
    };
    let order = if rng() < 0.8 {
        [CrossDir::North, near, far]
    } else {
        [CrossDir::North, far, near]
    };
    for dir in order {
        let (lane, col) = dest_of(player.lane, player.col, dir);
        if !is_lethal(state.seed, col, lane, tick) {
            return Some(dir);
        }
    }
    let (lane, col) = dest_of(player.lane, player.col, CrossDir::South);
    if !is_lethal(state.seed, col, lane, tick) {
        return Some(CrossDir::South);
    }
    None
}

#[derive(Clone, Copy, Debug)]
pub struct Cross;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CrossSeriesState {
    pub inner: CrossState,
    pub games_played: u64,
    pub balance_a: u64,
    pub balance_b: u64,
}

#[derive(Clone, Debug)]
pub struct CrossSeries {
    tunnel_id: String,
    stake_per_game: u64,
    inner: Cross,
}

impl CrossSeries {
    pub fn new(tunnel_id: impl Into<String>, stake_per_game: u64) -> Self {
        Self {
            tunnel_id: tunnel_id.into(),
            stake_per_game,
            inner: Cross,
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

    fn can_fund_next_game(&self, state: &CrossSeriesState) -> bool {
        self.stake_per_game == 0
            || (state.balance_a >= self.stake_per_game && state.balance_b >= self.stake_per_game)
    }

    fn swap(&self, balance_a: u64, balance_b: u64, winner: Option<Seat>) -> (u64, u64) {
        match winner {
            Some(Seat::A) => {
                let stake = self.stake_per_game.min(balance_b);
                (balance_a + stake, balance_b - stake)
            }
            Some(Seat::B) => {
                let stake = self.stake_per_game.min(balance_a);
                (balance_a - stake, balance_b + stake)
            }
            None => (balance_a, balance_b),
        }
    }
}

impl Protocol for Cross {
    type State = CrossState;
    type Move = CrossMove;

    fn name(&self) -> &str {
        "cross.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> CrossState {
        CrossState {
            tick: 0,
            seed: seed_from_tunnel_id(&ctx.tunnel_id),
            players: [spawn_player(), spawn_player()],
            winner: None,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            total: ctx.initial.sum(),
        }
    }

    fn apply_move(
        &self,
        state: &CrossState,
        mv: &CrossMove,
        _by: Seat,
    ) -> Result<CrossState, ProtocolError> {
        if self.is_terminal(state) {
            return Err(ProtocolError(
                "game over: the race is already decided".into(),
            ));
        }
        let tick = state.tick + 1;
        let players = [
            step_player(state.seed, state.players[0], mv.dir_a, tick),
            step_player(state.seed, state.players[1], mv.dir_b, tick),
        ];

        let mut winner = None;
        let a_won = players[0].lane >= WIN_LANE;
        let b_won = players[1].lane >= WIN_LANE;
        if a_won && b_won {
            if players[0].score > players[1].score {
                winner = Some(Seat::A);
            } else if players[1].score > players[0].score {
                winner = Some(Seat::B);
            }
        } else if a_won {
            winner = Some(Seat::A);
        } else if b_won {
            winner = Some(Seat::B);
        } else if tick >= TICK_CAP {
            if players[0].score > players[1].score {
                winner = Some(Seat::A);
            } else if players[1].score > players[0].score {
                winner = Some(Seat::B);
            }
        }

        let mut balance_a = state.balance_a;
        let mut balance_b = state.balance_b;
        match winner {
            Some(Seat::A) => {
                balance_a = state.total;
                balance_b = 0;
            }
            Some(Seat::B) => {
                balance_a = 0;
                balance_b = state.total;
            }
            None => {}
        }

        Ok(CrossState {
            tick,
            players,
            winner,
            balance_a,
            balance_b,
            ..state.clone()
        })
    }

    fn encode_state(&self, state: &CrossState) -> Vec<u8> {
        let mut out = Vec::with_capacity(DOMAIN.len() + 8 * 12 + 1);
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&u64_to_be_bytes(state.tick));
        out.extend_from_slice(&u64_to_be_bytes(state.seed));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_a));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_b));
        for player in &state.players {
            out.extend_from_slice(&u64_to_be_bytes(player.lane as u64));
            out.extend_from_slice(&u64_to_be_bytes(player.col as u64));
            out.extend_from_slice(&u64_to_be_bytes(player.score as u64));
            out.extend_from_slice(&u64_to_be_bytes(player.invuln_ticks));
        }
        out.push(match state.winner {
            Some(Seat::A) => 1,
            Some(Seat::B) => 2,
            None => 0,
        });
        out
    }

    fn balances(&self, state: &CrossState) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &CrossState) -> bool {
        state.winner.is_some() || state.tick >= TICK_CAP
    }

    fn sample_move(
        &self,
        state: &CrossState,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<CrossMove> {
        if self.is_terminal(state) {
            return None;
        }
        match seat {
            Seat::A => Some(CrossMove {
                dir_a: greedy_dir(state, 0, rng),
                dir_b: None,
            }),
            Seat::B => Some(CrossMove {
                dir_a: None,
                dir_b: greedy_dir(state, 1, rng),
            }),
        }
    }
}

fn push_length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u64_to_be_bytes(bytes.len() as u64));
    out.extend_from_slice(bytes);
}

impl Protocol for CrossSeries {
    type State = CrossSeriesState;
    type Move = CrossMove;

    fn name(&self) -> &str {
        "cross.series.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        CrossSeriesState {
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
                return Ok(CrossSeriesState {
                    inner: next_inner,
                    games_played: state.games_played,
                    balance_a,
                    balance_b,
                });
            }
            return Ok(CrossSeriesState {
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
        Ok(CrossSeriesState {
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
