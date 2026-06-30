use crate::{TicTacToe, TicTacToeMove, TicTacToeSeries, TicTacToeSeriesState, TicTacToeState};
use crate::{Winner, EMPTY, MARK_A, MARK_B};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Protocol, Seat};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicTacToeDifficulty {
    Perfect,
    Even,
    Uneven,
    Fast,
}

#[derive(Clone, Copy, Debug)]
pub struct TicTacToeStrategy {
    difficulty: TicTacToeDifficulty,
    fast_seed: u32,
}

impl TicTacToeStrategy {
    pub fn new(difficulty: TicTacToeDifficulty, fast_seed: u32) -> Self {
        Self {
            difficulty,
            fast_seed,
        }
    }

    fn pick_cell(&self, state: &TicTacToeState, seat: Seat) -> Option<u8> {
        let empties = empty_cells(&state.board);
        if empties.is_empty() {
            return None;
        }

        if self.difficulty == TicTacToeDifficulty::Fast {
            return Some(fast_pick(self.fast_seed, state, &empties));
        }

        let perfect = self.difficulty == TicTacToeDifficulty::Perfect
            || (self.difficulty == TicTacToeDifficulty::Uneven && seat == Seat::A);
        if perfect {
            return Some(perfect_cell(state, seat, &empties));
        }

        Some(heuristic_cell(
            state,
            mark_for(seat),
            &empties,
            self.fast_seed,
        ))
    }
}

impl Default for TicTacToeStrategy {
    fn default() -> Self {
        Self::new(TicTacToeDifficulty::Perfect, 0)
    }
}

/// Derive a deterministic 16-byte salt from a seed and move index.
///
/// Bots need idempotent salts so that `plan_move` on the same state always
/// produces the same move (including salt), which is required for replays.
fn derive_salt(seed: u32, moves_count: u8) -> Vec<u8> {
    let mut salt = [0u8; 16];
    let seed_bytes = seed.to_be_bytes();
    salt[..4].copy_from_slice(&seed_bytes);
    salt[4] = moves_count;
    // Fill remaining bytes with a simple expansion of the seed.
    for i in 5..16 {
        salt[i] = seed_bytes[(i - 5) % 4] ^ (i as u8);
    }
    salt.to_vec()
}

impl MoveStrategy<TicTacToe> for TicTacToeStrategy {
    async fn plan_move(
        &mut self,
        state: &TicTacToeState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<TicTacToeMove> {
        if state.winner != Winner::None || state.turn != seat {
            return None;
        }
        self.pick_cell(state, seat).map(|cell| TicTacToeMove {
            cell,
            salt: derive_salt(self.fast_seed, state.moves_count),
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TicTacToeSeriesStrategy {
    inner: TicTacToeStrategy,
}

impl TicTacToeSeriesStrategy {
    pub fn new(difficulty: TicTacToeDifficulty, fast_seed: u32) -> Self {
        Self {
            inner: TicTacToeStrategy::new(difficulty, fast_seed),
        }
    }
}

impl MoveStrategy<TicTacToeSeries> for TicTacToeSeriesStrategy {
    async fn plan_move(
        &mut self,
        state: &TicTacToeSeriesState,
        seat: Seat,
        ctx: &MoveStrategyContext,
    ) -> Option<TicTacToeMove> {
        if state.inner.winner == Winner::None {
            return self.inner.plan_move(&state.inner, seat, ctx).await;
        }
        let cannot_continue = state.games_played + 1 >= state.max_games
            || (state.inner.stake > 0
                && (state.inner.balance_a < state.inner.stake
                    || state.inner.balance_b < state.inner.stake));
        if cannot_continue || seat != Seat::A {
            return None;
        }
        Some(TicTacToeMove {
            cell: 0,
            salt: derive_salt(self.inner.fast_seed, state.inner.moves_count),
        })
    }
}

fn mark_for(seat: Seat) -> u8 {
    match seat {
        Seat::A => MARK_A,
        Seat::B => MARK_B,
    }
}

fn empty_cells(board: &[u8; 9]) -> Vec<u8> {
    board
        .iter()
        .enumerate()
        .filter_map(|(i, &cell)| (cell == EMPTY).then_some(i as u8))
        .collect()
}

fn fast_pick(seed: u32, state: &TicTacToeState, empties: &[u8]) -> u8 {
    let protocol = TicTacToe::new(state.stake).expect("stake is always valid");
    let idx = fast_index(seed, &protocol.encode_state(state), empties.len());
    empties[idx]
}

fn fast_index(seed: u32, bytes: &[u8], n: usize) -> usize {
    let mut h = seed ^ 0x811c_9dc5;
    for &byte in bytes {
        h = (h ^ byte as u32).wrapping_mul(0x0100_0193);
    }
    h as usize % n
}

fn heuristic_cell(state: &TicTacToeState, mark: u8, empties: &[u8], fast_seed: u32) -> u8 {
    let opponent = if mark == MARK_A { MARK_B } else { MARK_A };
    if let Some(cell) = find_finish(&state.board, mark) {
        return cell;
    }
    if let Some(cell) = find_finish(&state.board, opponent) {
        return cell;
    }
    fast_pick(fast_seed, state, empties)
}

fn find_finish(board: &[u8; 9], mark: u8) -> Option<u8> {
    for line in LINES {
        let mut marks = 0;
        let mut empty = None;
        for idx in line {
            match board[idx] {
                cell if cell == mark => marks += 1,
                EMPTY => empty = Some(idx as u8),
                _ => {}
            }
        }
        if marks == 2 && empty.is_some() {
            return empty;
        }
    }
    None
}

fn perfect_cell(state: &TicTacToeState, seat: Seat, empties: &[u8]) -> u8 {
    let us = mark_for(seat);
    let mut best_cell = empties[0];
    let mut best_score = i32::MIN;
    for &cell in empties {
        let mut board = state.board;
        board[cell as usize] = us;
        let score = minimax(&mut board, seat.other(), us, state.moves_count + 1, 1);
        if score > best_score {
            best_score = score;
            best_cell = cell;
        }
    }
    best_cell
}

fn minimax(board: &mut [u8; 9], turn: Seat, us: u8, moves_count: u8, depth: i32) -> i32 {
    match winner_for(board, moves_count) {
        Winner::A if us == MARK_A => return 10 - depth,
        Winner::B if us == MARK_B => return 10 - depth,
        Winner::A | Winner::B => return depth - 10,
        Winner::Draw => return 0,
        Winner::None => {}
    }

    let mark = mark_for(turn);
    let maximizing = mark == us;
    let mut best = if maximizing { i32::MIN } else { i32::MAX };
    for cell in empty_cells(board) {
        board[cell as usize] = mark;
        let score = minimax(board, turn.other(), us, moves_count + 1, depth + 1);
        board[cell as usize] = EMPTY;
        if maximizing {
            best = best.max(score);
        } else {
            best = best.min(score);
        }
    }
    best
}

fn winner_for(board: &[u8; 9], moves_count: u8) -> Winner {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EMPTY, MARK_A, MARK_B};
    use tunnel_harness::{Balances, Protocol, TunnelContext};

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "0xab".into(),
            initial: Balances { a: 100, b: 100 },
            seat: Seat::A,
        }
    }

    fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
        MoveStrategyContext {
            tunnel_id: "0xab".into(),
            seat,
        }
    }

    fn state_with(board: [u8; 9], turn: Seat, moves_count: u8) -> TicTacToeState {
        TicTacToeState {
            board,
            turn,
            moves_count,
            winner: Winner::None,
            balance_a: 100,
            balance_b: 100,
            total: 200,
            stake: 10,
            move_accumulator: [0u8; 32],
        }
    }

    fn test_salt() -> Vec<u8> {
        vec![0u8; 16]
    }

    #[tokio::test]
    async fn off_turn_seat_returns_none() {
        let protocol = TicTacToe::new(10).unwrap();
        let state = protocol.initial_state(&ctx());
        let mut strategy = TicTacToeStrategy::new(TicTacToeDifficulty::Fast, 7);

        let planned = strategy
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await;

        assert!(planned.is_none());
    }

    #[tokio::test]
    async fn turn_seat_returns_empty_cell_and_move_applies() {
        let protocol = TicTacToe::new(10).unwrap();
        let state = protocol.initial_state(&ctx());
        let mut strategy = TicTacToeStrategy::new(TicTacToeDifficulty::Fast, 7);

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("turn seat should plan");
        let next = protocol.apply_move(&state, &planned, Seat::A).unwrap();

        assert!(planned.cell < 9);
        assert_eq!(state.board[planned.cell as usize], EMPTY);
        assert_eq!(next.moves_count, 1);
        assert_eq!(next.turn, Seat::B);
        assert_eq!(next.balance_a + next.balance_b, state.total);
    }

    #[tokio::test]
    async fn fast_mode_is_idempotent_for_replayed_state() {
        let protocol = TicTacToe::new(10).unwrap();
        let state = protocol.initial_state(&ctx());
        let mut strategy = TicTacToeStrategy::new(TicTacToeDifficulty::Fast, 42);

        let a = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;
        let b = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;
        let c = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    #[tokio::test]
    async fn heuristic_completes_win_before_fallback() {
        let state = state_with(
            [
                MARK_A, MARK_A, EMPTY, //
                MARK_B, EMPTY, EMPTY, //
                EMPTY, EMPTY, MARK_B,
            ],
            Seat::A,
            4,
        );
        let mut strategy = TicTacToeStrategy::new(TicTacToeDifficulty::Even, 1);

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert!(planned.is_some_and(|m| m.cell == 2));
    }

    #[tokio::test]
    async fn heuristic_blocks_opponent_before_fallback() {
        let state = state_with(
            [
                MARK_B, MARK_B, EMPTY, //
                MARK_A, EMPTY, EMPTY, //
                EMPTY, EMPTY, MARK_A,
            ],
            Seat::A,
            4,
        );
        let mut strategy = TicTacToeStrategy::new(TicTacToeDifficulty::Even, 1);

        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await;

        assert!(planned.is_some_and(|m| m.cell == 2));
    }

    #[tokio::test]
    async fn series_kickoff_is_only_seat_a_while_session_live() {
        let protocol = TicTacToe::new(10).unwrap();
        let won =
            [0u8, 3, 1, 4, 2]
                .into_iter()
                .fold(protocol.initial_state(&ctx()), |state, cell| {
                    protocol
                        .apply_move(
                            &state,
                            &TicTacToeMove {
                                cell,
                                salt: test_salt(),
                            },
                            state.turn,
                        )
                        .unwrap()
                });
        let series_state = TicTacToeSeriesState {
            inner: won,
            games_played: 0,
            max_games: 2,
        };
        let mut strategy = TicTacToeSeriesStrategy::new(TicTacToeDifficulty::Fast, 5);

        let a = strategy
            .plan_move(&series_state, Seat::A, &strategy_ctx(Seat::A))
            .await;
        let b = strategy
            .plan_move(&series_state, Seat::B, &strategy_ctx(Seat::B))
            .await;

        assert!(a.is_some_and(|m| m.cell == 0));
        assert!(b.is_none());
    }

    #[tokio::test]
    async fn terminal_series_returns_none_for_both_seats() {
        let protocol = TicTacToe::new(10).unwrap();
        let won =
            [0u8, 3, 1, 4, 2]
                .into_iter()
                .fold(protocol.initial_state(&ctx()), |state, cell| {
                    protocol
                        .apply_move(
                            &state,
                            &TicTacToeMove {
                                cell,
                                salt: test_salt(),
                            },
                            state.turn,
                        )
                        .unwrap()
                });
        let series_state = TicTacToeSeriesState {
            inner: won,
            games_played: 0,
            max_games: 1,
        };
        let mut strategy = TicTacToeSeriesStrategy::new(TicTacToeDifficulty::Fast, 5);

        assert!(strategy
            .plan_move(&series_state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .is_none());
        assert!(strategy
            .plan_move(&series_state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn series_self_play_reaches_configured_cap_and_conserves_balances() {
        let protocol = TicTacToeSeries::new(2, 10).unwrap();
        let mut state = protocol.initial_state(&ctx());
        let mut a = TicTacToeSeriesStrategy::new(TicTacToeDifficulty::Fast, 1);
        let mut b = TicTacToeSeriesStrategy::new(TicTacToeDifficulty::Fast, 2);

        for _ in 0..64 {
            if protocol.is_terminal(&state) {
                break;
            }
            let planned_a = a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await;
            let planned_b = b.plan_move(&state, Seat::B, &strategy_ctx(Seat::B)).await;
            let (seat, mv) = match (planned_a, planned_b) {
                (Some(mv), None) => (Seat::A, mv),
                (None, Some(mv)) => (Seat::B, mv),
                other => panic!("expected exactly one planned move, got {other:?}"),
            };
            state = protocol.apply_move(&state, &mv, seat).unwrap();
            assert_eq!(protocol.balances(&state).sum(), 200);
        }

        assert!(protocol.is_terminal(&state));
    }
}
