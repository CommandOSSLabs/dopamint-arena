//! Tic-tac-toe protocol, byte-layout compatible with
//! `sui-tunnel-ts/src/protocol/ticTacToe.ts`.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_core::commitment::{compute_commitment, DOMAIN_COMMIT_REVEAL};
use tunnel_core::crypto::blake2b256;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub mod strategy;
pub use strategy::{TicTacToeDifficulty, TicTacToeSeriesStrategy, TicTacToeStrategy};

pub const EMPTY: u8 = 0;
pub const MARK_A: u8 = 1;
pub const MARK_B: u8 = 2;
const DOMAIN: &[u8] = b"sui_tunnel::proto::tic_tac_toe.v2";
const SERIES_DOMAIN: &[u8] = b"sui_tunnel::proto::tic_tac_toe.series.v2";

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
    /// 32-byte running commitment accumulator. Initialized from the v2 protocol
    /// domain; each move folds in `compute_commitment(mover||moveIndex||cell, salt)`
    /// so the full move history is unforgeable without replaying every move.
    pub move_accumulator: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TicTacToeMove {
    pub cell: u8,
    /// Per-move salt, >= 16 bytes (enforced by compute_commitment).
    #[serde(with = "tunnel_harness::wire_hex::bytes")]
    pub salt: Vec<u8>,
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

/// `lp(x) = u64be(len(x)) || x` — length-prefixed chunk for accumulator hashing.
fn push_length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u64_to_be_bytes(bytes.len() as u64));
    out.extend_from_slice(bytes);
}

/// Compute the initial accumulator seeded from the v2 protocol domain.
///
/// acc_0 = blake2b256(DOMAIN_COMMIT_REVEAL || lp(b"sui_tunnel::proto::tic_tac_toe.v2"))
fn initial_accumulator() -> [u8; 32] {
    let mut buf = Vec::with_capacity(DOMAIN_COMMIT_REVEAL.len() + 8 + DOMAIN.len());
    buf.extend_from_slice(DOMAIN_COMMIT_REVEAL);
    push_length_prefixed(&mut buf, DOMAIN);
    blake2b256(&buf)
}

/// Fold one commitment into the running accumulator.
///
/// acc' = blake2b256(DOMAIN_COMMIT_REVEAL || lp(prev_acc) || lp(commitment))
fn advance_accumulator(prev_acc: &[u8; 32], commitment: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(DOMAIN_COMMIT_REVEAL.len() + 2 * (8 + 32));
    buf.extend_from_slice(DOMAIN_COMMIT_REVEAL);
    push_length_prefixed(&mut buf, prev_acc);
    push_length_prefixed(&mut buf, commitment);
    blake2b256(&buf)
}

impl Protocol for TicTacToe {
    type State = TicTacToeState;
    type Move = TicTacToeMove;

    fn name(&self) -> &str {
        "tic_tac_toe.v2"
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
            move_accumulator: initial_accumulator(),
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

        // Fold the salted commitment into the accumulator.
        // value = u8(mover) || u64be(moveIndex) || u64be(cell)
        // mover: 1 for A, 2 for B; moveIndex = moves_count (post-increment).
        let mover_byte = match by {
            Seat::A => 1u8,
            Seat::B => 2u8,
        };
        let mut value = Vec::with_capacity(1 + 8 + 8);
        value.push(mover_byte);
        value.extend_from_slice(&u64_to_be_bytes(moves_count as u64));
        value.extend_from_slice(&u64_to_be_bytes(mv.cell as u64));
        let commitment = compute_commitment(&value, &mv.salt).map_err(ProtocolError)?;
        let move_accumulator = advance_accumulator(&state.move_accumulator, &commitment);

        Ok(TicTacToeState {
            board,
            turn: by.other(),
            moves_count,
            winner,
            balance_a,
            balance_b,
            total: state.total,
            stake: state.stake,
            move_accumulator,
        })
    }

    fn encode_state(&self, state: &TicTacToeState) -> Vec<u8> {
        let mut out = Vec::with_capacity(DOMAIN.len() + 9 + 3 + 24 + 32);
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
        out.extend_from_slice(&state.move_accumulator);
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
        // Derive a 16-byte deterministic salt from two rng() floats packed as f64be.
        let mut salt = [0u8; 16];
        salt[..8].copy_from_slice(&rng().to_be_bytes());
        salt[8..].copy_from_slice(&rng().to_be_bytes());
        Some(TicTacToeMove {
            cell: empties[idx],
            salt: salt.to_vec(),
        })
    }
}

impl Protocol for TicTacToeSeries {
    type State = TicTacToeSeriesState;
    type Move = TicTacToeMove;

    fn name(&self) -> &str {
        "tic_tac_toe.series.v2"
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

    fn can_gracefully_close(&self, state: &Self::State) -> bool {
        self.inner.is_terminal(&state.inner)
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
        Some(TicTacToeMove {
            cell: 0,
            salt: vec![0u8; 16],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "0xtest".into(),
            initial: Balances { a: 100, b: 100 },
            seat: Seat::A,
        }
    }

    /// Parity gate: Rust accumulator MUST match the TS golden vector.
    ///
    /// Golden values from Task A (TS ttt.v2, stake 0, balances 100/100):
    ///   acc0 = c67f8d9b8448d4eb2ccfc316cd107d03398a958eef4eb75fb2afb47cc1890cf9
    ///   acc1 after apply_move(cell=4, by=A, salt=[0x07;16])
    ///       = 13dd5eb9d2cf5456c5b4c0293c8e586ac020d185411aa221f0386072c153e18f
    #[test]
    fn move_accumulator_matches_ts_golden_vector() {
        let proto = TicTacToe::new(0).unwrap();
        let state = proto.initial_state(&ctx());

        let acc0_hex = hex::encode(state.move_accumulator);
        assert_eq!(
            acc0_hex, "c67f8d9b8448d4eb2ccfc316cd107d03398a958eef4eb75fb2afb47cc1890cf9",
            "acc0 mismatch: got {acc0_hex}"
        );

        let salt = vec![0x07u8; 16];
        let mv = TicTacToeMove { cell: 4, salt };
        let state1 = proto.apply_move(&state, &mv, Seat::A).unwrap();

        let acc1_hex = hex::encode(state1.move_accumulator);
        assert_eq!(
            acc1_hex, "13dd5eb9d2cf5456c5b4c0293c8e586ac020d185411aa221f0386072c153e18f",
            "acc1 mismatch: got {acc1_hex}"
        );
    }

    #[test]
    fn accumulator_is_deterministic() {
        let proto = TicTacToe::new(0).unwrap();
        let state = proto.initial_state(&ctx());
        let salt = vec![0xAAu8; 16];
        let mv = TicTacToeMove { cell: 0, salt };
        let s1 = proto.apply_move(&state, &mv, Seat::A).unwrap();
        let s2 = proto.apply_move(&state, &mv, Seat::A).unwrap();
        assert_eq!(s1.move_accumulator, s2.move_accumulator);
    }

    #[test]
    fn accumulator_differs_for_different_cells() {
        let proto = TicTacToe::new(0).unwrap();
        let state = proto.initial_state(&ctx());
        let salt = vec![0x01u8; 16];
        let s1 = proto
            .apply_move(
                &state,
                &TicTacToeMove {
                    cell: 0,
                    salt: salt.clone(),
                },
                Seat::A,
            )
            .unwrap();
        let s2 = proto
            .apply_move(
                &state,
                &TicTacToeMove {
                    cell: 1,
                    salt: salt.clone(),
                },
                Seat::A,
            )
            .unwrap();
        assert_ne!(s1.move_accumulator, s2.move_accumulator);
    }

    #[test]
    fn short_salt_is_rejected() {
        let proto = TicTacToe::new(0).unwrap();
        let state = proto.initial_state(&ctx());
        let result = proto.apply_move(
            &state,
            &TicTacToeMove {
                cell: 0,
                salt: vec![0u8; 15],
            },
            Seat::A,
        );
        assert!(result.is_err());
    }

    #[test]
    fn encode_state_appends_accumulator() {
        let proto = TicTacToe::new(0).unwrap();
        let state = proto.initial_state(&ctx());
        let encoded = proto.encode_state(&state);
        // Last 32 bytes are the move_accumulator.
        assert_eq!(&encoded[encoded.len() - 32..], &state.move_accumulator);
        // Domain is v2.
        assert!(encoded.starts_with(b"sui_tunnel::proto::tic_tac_toe.v2"));
    }

    #[test]
    fn series_uses_v2_domain() {
        let proto = TicTacToeSeries::new(2, 0).unwrap();
        let state = proto.initial_state(&ctx());
        assert_eq!(proto.name(), "tic_tac_toe.series.v2");
        assert!(proto
            .encode_state(&state)
            .starts_with(b"sui_tunnel::proto::tic_tac_toe.series.v2"));
    }

    #[test]
    fn series_can_gracefully_close_at_game_boundary_before_terminal() {
        let proto = TicTacToeSeries::new(2, 0).unwrap();
        let mut state = proto.initial_state(&ctx());

        assert!(!proto.can_gracefully_close(&state));
        state.inner.winner = Winner::Draw;

        assert!(proto.can_gracefully_close(&state));
        assert!(!proto.is_terminal(&state));
    }
}

#[cfg(test)]
mod move_wire_parity {
    use super::*;

    // The relayed move is JSON; the FE `tttMoveCodec` sends `{cell:<number>, salt:"<bare-hex>"}`
    // (lowercase hex, NO 0x). The bot's `TicTacToeMove` serde MUST match or the move loop can't decode.
    // Pins the bare-hex contract (the salt serde regression guard).
    #[test]
    fn move_json_matches_fe_ttt_move_codec() {
        let m = TicTacToeMove {
            cell: 4,
            salt: vec![0xab; 16],
        };
        assert_eq!(
            serde_json::to_value(&m).unwrap(),
            serde_json::json!({ "cell": 4, "salt": "ab".repeat(16) }),
        );
        // Decodes the FE's exact bytes (bare hex); also tolerates an optional 0x prefix.
        let parsed: TicTacToeMove =
            serde_json::from_value(serde_json::json!({ "cell": 0, "salt": "00".repeat(16) }))
                .unwrap();
        assert_eq!(parsed.cell, 0);
        assert_eq!(parsed.salt, vec![0u8; 16]);
    }
}
