//! Tic-tac-toe protocol, byte-layout compatible with
//! `sui-tunnel-ts/src/protocol/ticTacToe.ts`.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub mod strategy;
pub use strategy::{TicTacToeDifficulty, TicTacToeSeriesStrategy, TicTacToeStrategy};

pub const EMPTY: u8 = 0;
pub const MARK_A: u8 = 1;
pub const MARK_B: u8 = 2;
const DOMAIN: &[u8] = b"sui_tunnel::proto::tic_tac_toe.v1";
const SERIES_DOMAIN: &[u8] = b"sui_tunnel::proto::tic_tac_toe.series.v1";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Winner {
    None,
    A,
    B,
    Draw,
}

impl Winner {
    fn code(self) -> u8 {
        match self {
            Winner::None => 0,
            Winner::A => 1,
            Winner::B => 2,
            Winner::Draw => 3,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TicTacToeState {
    pub board: [u8; 9],
    pub turn: Seat,
    pub moves_count: u8,
    pub winner: Winner,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
    pub stake: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TicTacToeMove {
    pub cell: u8,
}

#[derive(Clone, Copy, Debug)]
pub struct TicTacToe {
    default_stake: u64,
}

impl TicTacToe {
    pub fn new(stake: u64) -> Result<Self, ProtocolError> {
        Ok(TicTacToe {
            default_stake: stake,
        })
    }
}

#[derive(Clone, Debug)]
pub struct TicTacToeSeriesState {
    pub inner: TicTacToeState,
    pub games_played: u64,
    pub max_games: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct TicTacToeSeries {
    inner: TicTacToe,
    max_games: u64,
}

impl TicTacToeSeries {
    pub fn new(max_games: u64, stake: u64) -> Result<Self, ProtocolError> {
        if max_games == 0 {
            return Err(ProtocolError("max_games must be positive".into()));
        }
        Ok(Self {
            inner: TicTacToe::new(stake)?,
            max_games,
        })
    }

    fn can_fund_next_game(&self, inner: &TicTacToeState) -> bool {
        inner.stake == 0 || (inner.balance_a >= inner.stake && inner.balance_b >= inner.stake)
    }
}

impl Default for TicTacToe {
    fn default() -> Self {
        TicTacToe { default_stake: 100 }
    }
}

const LINES: [[usize; 3]; 8] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
];

fn mark_for(seat: Seat) -> u8 {
    match seat {
        Seat::A => MARK_A,
        Seat::B => MARK_B,
    }
}

fn check_winner(board: &[u8; 9], moves_count: u8) -> Winner {
    for [x, y, z] in LINES {
        let v = board[x];
        if v != EMPTY && v == board[y] && v == board[z] {
            return if v == MARK_A { Winner::A } else { Winner::B };
        }
    }
    if moves_count == 9 {
        Winner::Draw
    } else {
        Winner::None
    }
}

impl Protocol for TicTacToe {
    type State = TicTacToeState;
    type Move = TicTacToeMove;

    fn name(&self) -> &str {
        "tic_tac_toe.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> TicTacToeState {
        let stake = self.default_stake.min(ctx.initial.a.min(ctx.initial.b));
        TicTacToeState {
            board: [EMPTY; 9],
            turn: Seat::A,
            moves_count: 0,
            winner: Winner::None,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            total: ctx.initial.sum(),
            stake,
        }
    }

    fn apply_move(
        &self,
        state: &TicTacToeState,
        mv: &TicTacToeMove,
        by: Seat,
    ) -> Result<TicTacToeState, ProtocolError> {
        if state.winner != Winner::None {
            return Err(ProtocolError("game already over".into()));
        }
        if by != state.turn {
            return Err(ProtocolError("not this seat's turn".into()));
        }
        if mv.cell > 8 {
            return Err(ProtocolError(format!("cell out of range: {}", mv.cell)));
        }
        let cell = mv.cell as usize;
        if state.board[cell] != EMPTY {
            return Err(ProtocolError(format!("cell {} occupied", mv.cell)));
        }

        let mut board = state.board;
        board[cell] = mark_for(by);
        let moves_count = state.moves_count + 1;
        let winner = check_winner(&board, moves_count);

        let mut balance_a = state.balance_a;
        let mut balance_b = state.balance_b;
        match winner {
            Winner::A => {
                let shift = state.stake.min(state.balance_b);
                balance_a += shift;
                balance_b -= shift;
            }
            Winner::B => {
                let shift = state.stake.min(state.balance_a);
                balance_a -= shift;
                balance_b += shift;
            }
            Winner::None | Winner::Draw => {}
        }

        Ok(TicTacToeState {
            board,
            turn: by.other(),
            moves_count,
            winner,
            balance_a,
            balance_b,
            total: state.total,
            stake: state.stake,
        })
    }

    fn encode_state(&self, state: &TicTacToeState) -> Vec<u8> {
        let mut out = Vec::with_capacity(DOMAIN.len() + 9 + 3 + 24);
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&state.board);
        out.push(state.moves_count);
        out.push(state.winner.code());
        out.push(match state.turn {
            Seat::A => 0,
            Seat::B => 1,
        });
        out.extend_from_slice(&u64_to_be_bytes(state.balance_a));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_b));
        out.extend_from_slice(&u64_to_be_bytes(state.stake));
        out
    }

    fn balances(&self, state: &TicTacToeState) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &TicTacToeState) -> bool {
        state.winner != Winner::None
    }

    fn sample_move(
        &self,
        state: &TicTacToeState,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<TicTacToeMove> {
        if state.winner != Winner::None || seat != state.turn {
            return None;
        }
        let empties: Vec<u8> = state
            .board
            .iter()
            .enumerate()
            .filter_map(|(i, &cell)| (cell == EMPTY).then_some(i as u8))
            .collect();
        if empties.is_empty() {
            return None;
        }
        let raw = (rng() * empties.len() as f64).floor() as usize;
        let idx = raw.min(empties.len() - 1);
        Some(TicTacToeMove { cell: empties[idx] })
    }
}

fn push_length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u64_to_be_bytes(bytes.len() as u64));
    out.extend_from_slice(bytes);
}

impl Protocol for TicTacToeSeries {
    type State = TicTacToeSeriesState;
    type Move = TicTacToeMove;

    fn name(&self) -> &str {
        "tic_tac_toe.series.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        TicTacToeSeriesState {
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
            return Ok(TicTacToeSeriesState {
                inner: self.inner.apply_move(&state.inner, mv, by)?,
                ..state.clone()
            });
        }
        if self.is_terminal(state) {
            return Err(ProtocolError(
                "session over: no more games can be played".into(),
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
        Ok(TicTacToeSeriesState {
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
        if !self.inner.is_terminal(&state.inner) {
            return self.inner.sample_move(&state.inner, seat, rng);
        }
        if self.is_terminal(state) || seat != Seat::A {
            return None;
        }
        Some(TicTacToeMove { cell: 0 })
    }
}
