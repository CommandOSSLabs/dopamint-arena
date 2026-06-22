import {
  CELL_EMPTY,
  CELL_PLAYER,
  CELL_SERVER,
  STATUS_ONGOING,
  STATUS_PLAYER_WIN,
  STATUS_SERVER_WIN,
  STATUS_DRAW,
} from "../constants";

export type Board = number[]; // length 9, values 0|1|2

export const WIN_LINES: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function legalMoves(board: Board): number[] {
  const moves: number[] = [];
  for (let i = 0; i < 9; i++) if (board[i] === CELL_EMPTY) moves.push(i);
  return moves;
}

export function winner(board: Board): number {
  for (const [a, b, c] of WIN_LINES) {
    if (
      board[a] !== CELL_EMPTY &&
      board[a] === board[b] &&
      board[b] === board[c]
    ) {
      return board[a];
    }
  }
  return 0;
}

export function checkStatus(board: Board): number {
  const w = winner(board);
  if (w === CELL_PLAYER) return STATUS_PLAYER_WIN;
  if (w === CELL_SERVER) return STATUS_SERVER_WIN;
  if (legalMoves(board).length === 0) return STATUS_DRAW;
  return STATUS_ONGOING;
}

export function applyMove(board: Board, cell: number, value: number): Board {
  const next = board.slice();
  next[cell] = value;
  return next;
}
