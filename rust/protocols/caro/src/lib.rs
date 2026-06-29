//! Caro (five-in-a-row) protocols, ported from the TS arena package.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub mod strategy;
pub use strategy::{CaroSeriesStrategy, CaroStrategy, CaroStrength};

pub const EMPTY: u8 = 0;
pub const MARK_A: u8 = 1;
pub const MARK_B: u8 = 2;
pub const DRAW: u8 = 3;

const DOMAIN: &[u8] = b"sui_tunnel::proto::caro.v1";
const SERIES_DOMAIN: &[u8] = b"sui_tunnel::proto::caro.series.v1";
const DIRS: [(i32, i32); 4] = [(0, 1), (1, 0), (1, 1), (1, -1)];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaroState {
    pub board: Vec<u8>,
    pub size: usize,
    pub turn: Seat,
    pub winner: u8,
    pub last_move: i64,
    pub moves_count: usize,
    pub balance_a: u64,
    pub balance_b: u64,
    pub stake: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CaroMove {
    pub cell: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaroSeriesState {
    pub inner: CaroState,
    pub games_played: u64,
    pub max_games: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct Caro {
    size: usize,
    default_stake: u64,
}

impl Caro {
    pub fn new(size: usize, stake: u64) -> Result<Self, ProtocolError> {
        if size < 3 {
            return Err(ProtocolError(
                "caro board size must be an integer >= 3".into(),
            ));
        }
        Ok(Self {
            size,
            default_stake: stake,
        })
    }
}

impl Default for Caro {
    fn default() -> Self {
        Self {
            size: 15,
            default_stake: 0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CaroSeries {
    inner: Caro,
    max_games: u64,
}

impl CaroSeries {
    pub fn new(max_games: u64, size: usize, stake: u64) -> Result<Self, ProtocolError> {
        if max_games == 0 {
            return Err(ProtocolError("max_games must be positive".into()));
        }
        Ok(Self {
            inner: Caro::new(size, stake)?,
            max_games,
        })
    }

    fn can_fund_next_game(&self, inner: &CaroState) -> bool {
        inner.stake == 0 || (inner.balance_a >= inner.stake && inner.balance_b >= inner.stake)
    }
}

fn mark_for(seat: Seat) -> u8 {
    match seat {
        Seat::A => MARK_A,
        Seat::B => MARK_B,
    }
}

fn in_bounds(size: usize, row: i32, col: i32) -> bool {
    row >= 0 && row < size as i32 && col >= 0 && col < size as i32
}

pub fn winner_around(board: &[u8], size: usize, idx: usize) -> u8 {
    if idx >= size * size {
        return EMPTY;
    }
    let mark = board[idx];
    if mark == EMPTY {
        return EMPTY;
    }
    let row0 = (idx / size) as i32;
    let col0 = (idx % size) as i32;
    for (dr, dc) in DIRS {
        let mut count = 1;
        let mut row = row0 + dr;
        let mut col = col0 + dc;
        while in_bounds(size, row, col) && board[row as usize * size + col as usize] == mark {
            count += 1;
            row += dr;
            col += dc;
        }
        row = row0 - dr;
        col = col0 - dc;
        while in_bounds(size, row, col) && board[row as usize * size + col as usize] == mark {
            count += 1;
            row -= dr;
            col -= dc;
        }
        if count >= 5 {
            return mark;
        }
    }
    EMPTY
}

fn push_length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u64_to_be_bytes(bytes.len() as u64));
    out.extend_from_slice(bytes);
}

fn encode_caro_state(state: &CaroState) -> Vec<u8> {
    let mut body = Vec::new();
    push_length_prefixed(&mut body, &u64_to_be_bytes(state.size as u64));
    push_length_prefixed(&mut body, &state.board);
    push_length_prefixed(
        &mut body,
        &[
            match state.turn {
                Seat::A => 0,
                Seat::B => 1,
            },
            state.winner,
        ],
    );
    push_length_prefixed(&mut body, &u64_to_be_bytes(state.balance_a));
    push_length_prefixed(&mut body, &u64_to_be_bytes(state.balance_b));
    push_length_prefixed(&mut body, &u64_to_be_bytes(state.stake));

    let mut out = Vec::with_capacity(DOMAIN.len() + body.len());
    out.extend_from_slice(DOMAIN);
    out.extend_from_slice(&body);
    out
}

impl Protocol for Caro {
    type State = CaroState;
    type Move = CaroMove;

    fn name(&self) -> &str {
        "caro.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        let stake = self.default_stake.min(ctx.initial.a.min(ctx.initial.b));
        CaroState {
            board: vec![EMPTY; self.size * self.size],
            size: self.size,
            turn: Seat::A,
            winner: EMPTY,
            last_move: -1,
            moves_count: 0,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            stake,
        }
    }

    fn apply_move(
        &self,
        state: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, ProtocolError> {
        if state.winner != EMPTY {
            return Err(ProtocolError("caro: game already over".into()));
        }
        if by != state.turn {
            return Err(ProtocolError("caro: not this party's turn".into()));
        }
        if mv.cell < 0 || mv.cell >= (state.size * state.size) as i64 {
            return Err(ProtocolError("caro: cell out of range".into()));
        }
        let cell = mv.cell as usize;
        if state.board[cell] != EMPTY {
            return Err(ProtocolError("caro: cell occupied".into()));
        }

        let mut board = state.board.clone();
        board[cell] = mark_for(by);
        let moves_count = state.moves_count + 1;
        let mut winner = winner_around(&board, state.size, cell);
        if winner == EMPTY && moves_count == state.size * state.size {
            winner = DRAW;
        }

        let mut balance_a = state.balance_a;
        let mut balance_b = state.balance_b;
        match winner {
            MARK_A => {
                let shift = state.stake.min(state.balance_b);
                balance_a += shift;
                balance_b -= shift;
            }
            MARK_B => {
                let shift = state.stake.min(state.balance_a);
                balance_a -= shift;
                balance_b += shift;
            }
            _ => {}
        }

        Ok(CaroState {
            board,
            turn: by.other(),
            winner,
            last_move: mv.cell,
            moves_count,
            balance_a,
            balance_b,
            ..state.clone()
        })
    }

    fn encode_state(&self, state: &Self::State) -> Vec<u8> {
        encode_caro_state(state)
    }

    fn balances(&self, state: &Self::State) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &Self::State) -> bool {
        state.winner != EMPTY
    }

    fn sample_move(
        &self,
        state: &Self::State,
        seat: Seat,
        _rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        if state.winner != EMPTY || seat != state.turn {
            return None;
        }
        state
            .board
            .iter()
            .position(|&cell| cell == EMPTY)
            .map(|cell| CaroMove { cell: cell as i64 })
    }
}

impl Protocol for CaroSeries {
    type State = CaroSeriesState;
    type Move = CaroMove;

    fn name(&self) -> &str {
        "caro.series.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        CaroSeriesState {
            inner: self.inner.initial_state(ctx),
            games_played: 0,
            max_games: self.max_games,
        }
    }

    fn apply_move(
        &self,
        state: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, ProtocolError> {
        if !self.inner.is_terminal(&state.inner) {
            return Ok(CaroSeriesState {
                inner: self.inner.apply_move(&state.inner, mv, by)?,
                ..state.clone()
            });
        }
        if self.is_terminal(state) {
            return Err(ProtocolError(
                "caro session over: no more games can be played".into(),
            ));
        }
        let ctx = TunnelContext {
            tunnel_id: String::new(),
            initial: Balances {
                a: state.inner.balance_a,
                b: state.inner.balance_b,
            },
            seat: by,
        };
        Ok(CaroSeriesState {
            inner: self.inner.initial_state(&ctx),
            games_played: state.games_played + 1,
            max_games: state.max_games,
        })
    }

    fn encode_state(&self, state: &Self::State) -> Vec<u8> {
        let inner = self.inner.encode_state(&state.inner);
        let mut body = Vec::new();
        push_length_prefixed(&mut body, &inner);
        push_length_prefixed(&mut body, &u64_to_be_bytes(state.games_played));
        let mut out = Vec::with_capacity(SERIES_DOMAIN.len() + body.len());
        out.extend_from_slice(SERIES_DOMAIN);
        out.extend_from_slice(&body);
        out
    }

    fn balances(&self, state: &Self::State) -> Balances {
        self.inner.balances(&state.inner)
    }

    fn is_terminal(&self, state: &Self::State) -> bool {
        if !self.inner.is_terminal(&state.inner) {
            return false;
        }
        state.games_played + 1 >= state.max_games || !self.can_fund_next_game(&state.inner)
    }

    fn sample_move(
        &self,
        state: &Self::State,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        if self.is_terminal(state) {
            return None;
        }
        if self.inner.is_terminal(&state.inner) {
            return (seat == Seat::A).then_some(CaroMove { cell: 0 });
        }
        self.inner.sample_move(&state.inner, seat, rng)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "0xtest".into(),
            initial: Balances { a: 1, b: 1 },
            seat: Seat::A,
        }
    }

    fn play_a_five(proto: &Caro, mut state: CaroState) -> CaroState {
        let size = state.size as i64;
        for col in 0..4 {
            state = proto
                .apply_move(&state, &CaroMove { cell: col }, Seat::A)
                .unwrap();
            state = proto
                .apply_move(
                    &state,
                    &CaroMove {
                        cell: 5 * size + col,
                    },
                    Seat::B,
                )
                .unwrap();
        }
        proto
            .apply_move(&state, &CaroMove { cell: 4 }, Seat::A)
            .unwrap()
    }

    #[test]
    fn initial_state_is_empty_board() {
        let proto = Caro::new(15, 0).unwrap();
        let state = proto.initial_state(&ctx());
        assert_eq!(state.size, 15);
        assert_eq!(state.board.len(), 225);
        assert!(state.board.iter().all(|&cell| cell == EMPTY));
        assert_eq!(state.turn, Seat::A);
        assert_eq!(state.winner, EMPTY);
        assert_eq!(state.last_move, -1);
        assert_eq!(state.moves_count, 0);
    }

    #[test]
    fn rejects_illegal_moves() {
        let proto = Caro::new(15, 0).unwrap();
        let state = proto.initial_state(&ctx());
        assert!(proto
            .apply_move(&state, &CaroMove { cell: -1 }, Seat::A)
            .is_err());
        assert!(proto
            .apply_move(&state, &CaroMove { cell: 225 }, Seat::A)
            .is_err());
        assert!(proto
            .apply_move(&state, &CaroMove { cell: 0 }, Seat::B)
            .is_err());
        let next = proto
            .apply_move(&state, &CaroMove { cell: 0 }, Seat::A)
            .unwrap();
        assert!(proto
            .apply_move(&next, &CaroMove { cell: 0 }, Seat::B)
            .is_err());
        assert!(proto
            .apply_move(&next, &CaroMove { cell: 1 }, Seat::A)
            .is_err());
    }

    #[test]
    fn winning_move_sets_terminal_winner() {
        let proto = Caro::new(15, 0).unwrap();
        let state = play_a_five(&proto, proto.initial_state(&ctx()));
        assert_eq!(state.winner, MARK_A);
        assert!(proto.is_terminal(&state));
        assert!(proto
            .apply_move(&state, &CaroMove { cell: 100 }, Seat::B)
            .is_err());
    }

    #[test]
    fn three_by_three_can_fill_to_draw() {
        let proto = Caro::new(3, 0).unwrap();
        let mut state = proto.initial_state(&ctx());
        for (cell, seat) in [
            (0, Seat::A),
            (1, Seat::B),
            (2, Seat::A),
            (4, Seat::B),
            (3, Seat::A),
            (5, Seat::B),
            (7, Seat::A),
            (6, Seat::B),
            (8, Seat::A),
        ] {
            state = proto.apply_move(&state, &CaroMove { cell }, seat).unwrap();
        }
        assert_eq!(state.winner, DRAW);
        assert!(proto.is_terminal(&state));
    }

    #[test]
    fn encode_state_is_deterministic_and_size_scoped() {
        let p15 = Caro::new(15, 0).unwrap();
        let s15 = p15.initial_state(&ctx());
        assert_eq!(p15.encode_state(&s15), p15.encode_state(&s15.clone()));
        let after = p15
            .apply_move(&s15, &CaroMove { cell: 0 }, Seat::A)
            .unwrap();
        assert_ne!(p15.encode_state(&after), p15.encode_state(&s15));

        let p19 = Caro::new(19, 0).unwrap();
        assert_ne!(
            p15.encode_state(&s15),
            p19.encode_state(&p19.initial_state(&ctx()))
        );
    }

    #[test]
    fn series_uses_canonical_protocol_id() {
        let proto = CaroSeries::new(2, 3, 0).unwrap();
        let state = proto.initial_state(&ctx());
        assert_eq!(proto.name(), "caro.series.v1");
        assert!(proto
            .encode_state(&state)
            .starts_with(b"sui_tunnel::proto::caro.series.v1"));
    }

    #[test]
    fn staked_win_shifts_stake_loser_to_winner() {
        // Stake 50; each player starts with 1000.
        // A wins with five-in-a-row: A gains 50, B loses 50.
        let proto = Caro::new(15, 50).unwrap();
        let ctx = TunnelContext {
            tunnel_id: "0xtest".into(),
            initial: Balances { a: 1000, b: 1000 },
            seat: Seat::A,
        };
        let state = proto.initial_state(&ctx);
        assert_eq!(state.stake, 50);

        let final_state = play_a_five(&proto, state);
        assert_eq!(final_state.winner, MARK_A);
        assert_eq!(final_state.balance_a, 1050);
        assert_eq!(final_state.balance_b, 950);
        assert_eq!(final_state.balance_a + final_state.balance_b, 2000);
    }

    #[test]
    fn staked_draw_leaves_balances_unchanged() {
        let proto = Caro::new(3, 100).unwrap();
        let ctx = TunnelContext {
            tunnel_id: "0xtest".into(),
            initial: Balances { a: 500, b: 500 },
            seat: Seat::A,
        };
        let mut state = proto.initial_state(&ctx);
        assert_eq!(state.stake, 100);

        for (cell, seat) in [
            (0, Seat::A),
            (1, Seat::B),
            (2, Seat::A),
            (4, Seat::B),
            (3, Seat::A),
            (5, Seat::B),
            (7, Seat::A),
            (6, Seat::B),
            (8, Seat::A),
        ] {
            state = proto.apply_move(&state, &CaroMove { cell }, seat).unwrap();
        }
        assert_eq!(state.winner, DRAW);
        assert_eq!(state.balance_a, 500);
        assert_eq!(state.balance_b, 500);
    }

    #[test]
    fn stake_clamped_to_minimum_balance() {
        // Default stake 200, but B only has 80 — clamp to 80.
        let proto = Caro::new(15, 200).unwrap();
        let ctx = TunnelContext {
            tunnel_id: "0xtest".into(),
            initial: Balances { a: 1000, b: 80 },
            seat: Seat::A,
        };
        let state = proto.initial_state(&ctx);
        assert_eq!(state.stake, 80);

        let final_state = play_a_five(&proto, state);
        assert_eq!(final_state.winner, MARK_A);
        assert_eq!(final_state.balance_a, 1080);
        assert_eq!(final_state.balance_b, 0);
    }

    #[test]
    fn series_terminates_when_loser_cannot_fund_next_game() {
        // Stake 100; B starts with 50 — after game 1 (A wins), B has 0.
        // Series should be terminal after game 1 even though max_games = 3.
        let proto = CaroSeries::new(3, 15, 100).unwrap();
        let ctx = TunnelContext {
            tunnel_id: "0xtest".into(),
            initial: Balances { a: 1000, b: 50 },
            seat: Seat::A,
        };
        let mut state = proto.initial_state(&ctx);
        // Clamped stake = min(100, 50) = 50.
        assert_eq!(state.inner.stake, 50);

        state.inner = play_a_five(&proto.inner, state.inner);
        assert_eq!(state.inner.winner, MARK_A);
        assert_eq!(state.inner.balance_b, 0);
        // B cannot fund the next game (balance 0 < stake 50), so series is terminal.
        assert!(proto.is_terminal(&state));
    }
}
