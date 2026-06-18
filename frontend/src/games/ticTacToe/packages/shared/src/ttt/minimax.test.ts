import { describe, expect, it } from "bun:test";
import { optimalMoves } from "./minimax";
import { CELL_EMPTY, CELL_PLAYER, CELL_SERVER } from "../constants";

const E = CELL_EMPTY,
  X = CELL_PLAYER,
  O = CELL_SERVER;

describe("minimax optimalMoves", () => {
  it("takes the immediate winning move", () => {
    // server O at 0,1 ; cell 2 completes the top row
    const board = [O, O, E, X, X, E, E, E, E];
    expect(optimalMoves(board, O)).toEqual([2]);
  });

  it("blocks the opponent's immediate win", () => {
    // player X at 0,1 threatens 2; server must block at 2
    const board = [X, X, E, O, E, E, E, E, E];
    expect(optimalMoves(board, O)).toEqual([2]);
  });

  it("returns cells ascending", () => {
    const board = Array(9).fill(E);
    const moves = optimalMoves(board, X);
    const sorted = [...moves].sort((a, b) => a - b);
    expect(moves).toEqual(sorted);
  });

  it("never loses from an empty board (optimal set is non-empty)", () => {
    expect(optimalMoves(Array(9).fill(E), X).length).toBeGreaterThan(0);
  });
});
