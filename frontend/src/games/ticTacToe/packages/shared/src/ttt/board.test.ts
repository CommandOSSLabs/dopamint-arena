import { describe, expect, it } from "bun:test";
import { legalMoves, winner, checkStatus, applyMove, WIN_LINES } from "./board";
import {
  CELL_EMPTY,
  CELL_PLAYER,
  CELL_SERVER,
  STATUS_ONGOING,
  STATUS_PLAYER_WIN,
  STATUS_SERVER_WIN,
  STATUS_DRAW,
} from "../constants";

const E = CELL_EMPTY,
  X = CELL_PLAYER,
  O = CELL_SERVER;

describe("board", () => {
  it("legalMoves returns empty cells ascending", () => {
    expect(legalMoves([X, E, O, E, X, E, E, E, O])).toEqual([1, 3, 5, 6, 7]);
  });

  it("detects a player win on every line", () => {
    for (const [a, b, c] of WIN_LINES) {
      const board = Array(9).fill(E);
      board[a] = X;
      board[b] = X;
      board[c] = X;
      expect(winner(board)).toBe(X);
      expect(checkStatus(board)).toBe(STATUS_PLAYER_WIN);
    }
  });

  it("detects a server win", () => {
    expect(checkStatus([O, O, O, X, X, E, E, E, E])).toBe(STATUS_SERVER_WIN);
  });

  it("detects a draw on a full board with no winner", () => {
    expect(checkStatus([X, O, X, X, O, O, O, X, X])).toBe(STATUS_DRAW);
  });

  it("reports ongoing for an unfinished board", () => {
    expect(checkStatus([X, E, E, E, E, E, E, E, E])).toBe(STATUS_ONGOING);
  });

  it("applyMove is immutable and sets the cell", () => {
    const board = Array(9).fill(E);
    const next = applyMove(board, 4, X);
    expect(next[4]).toBe(X);
    expect(board[4]).toBe(E);
  });
});
