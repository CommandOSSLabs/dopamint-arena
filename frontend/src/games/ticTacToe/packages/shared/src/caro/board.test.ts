import { describe, expect, it } from "bun:test";
import {
  winnerAround,
  winningLine,
  isFull,
  inBounds,
  applyMark,
} from "./board";

// Helper: empty size*size board.
const empty = (size: number) => new Array(size * size).fill(0) as number[];
const idx = (size: number, r: number, c: number) => r * size + c;

describe("caro board", () => {
  it("inBounds rejects off-grid coordinates", () => {
    expect(inBounds(15, 0, 0)).toBe(true);
    expect(inBounds(15, 14, 14)).toBe(true);
    expect(inBounds(15, -1, 0)).toBe(false);
    expect(inBounds(15, 0, 15)).toBe(false);
  });

  it("applyMark returns a new board without mutating the input", () => {
    const b = empty(15);
    const b2 = applyMark(b, 7, 1);
    expect(b2[7]).toBe(1);
    expect(b[7]).toBe(0); // original untouched
    expect(b2).not.toBe(b);
  });

  it("detects a horizontal five-in-a-row through the last move", () => {
    const size = 15;
    let b = empty(size);
    // Place marks at row 2, cols 3..7; last move = col 7.
    for (let c = 3; c <= 7; c++) b = applyMark(b, idx(size, 2, c), 1);
    expect(winnerAround(b, size, idx(size, 2, 7))).toBe(1);
  });

  it("detects vertical and both diagonals", () => {
    const size = 15;
    // Vertical col 5, rows 4..8.
    let v = empty(size);
    for (let r = 4; r <= 8; r++) v = applyMark(v, idx(size, r, 5), 2);
    expect(winnerAround(v, size, idx(size, 8, 5))).toBe(2);

    // Down-right diagonal (1,1).
    let d1 = empty(size);
    for (let k = 0; k < 5; k++) d1 = applyMark(d1, idx(size, 1 + k, 1 + k), 1);
    expect(winnerAround(d1, size, idx(size, 5, 5))).toBe(1);

    // Down-left diagonal (1,-1).
    let d2 = empty(size);
    for (let k = 0; k < 5; k++) d2 = applyMark(d2, idx(size, 1 + k, 10 - k), 2);
    expect(winnerAround(d2, size, idx(size, 5, 6))).toBe(2);
  });

  it("an overline (6 in a row) does not win (standard caro: exactly five)", () => {
    const size = 15;
    let b = empty(size);
    for (let c = 2; c <= 7; c++) b = applyMark(b, idx(size, 0, c), 1); // 6 marks
    expect(winnerAround(b, size, idx(size, 0, 7))).toBe(0);
  });

  it("a five flanked by the opponent on both ends does not win", () => {
    const size = 15;
    let b = empty(size);
    b = applyMark(b, idx(size, 2, 2), 2); // O blocks the left end
    for (let c = 3; c <= 7; c++) b = applyMark(b, idx(size, 2, c), 1); // X x5
    b = applyMark(b, idx(size, 2, 8), 2); // O blocks the right end
    expect(winnerAround(b, size, idx(size, 2, 7))).toBe(0);
  });

  it("a five blocked on only one end still wins (other end open)", () => {
    const size = 15;
    let b = empty(size);
    b = applyMark(b, idx(size, 4, 2), 2); // O blocks the left end; col 8 left empty
    for (let c = 3; c <= 7; c++) b = applyMark(b, idx(size, 4, c), 1); // X x5
    expect(winnerAround(b, size, idx(size, 4, 7))).toBe(1);
  });

  it("the board edge counts as an open end (a five against the wall wins)", () => {
    const size = 15;
    let b = empty(size);
    for (let c = 0; c <= 4; c++) b = applyMark(b, idx(size, 5, c), 1); // X x5 at the wall
    b = applyMark(b, idx(size, 5, 5), 2); // O blocks the inner end; the wall end is open
    expect(winnerAround(b, size, idx(size, 5, 4))).toBe(1);
  });

  it("does not fire on only four in a row", () => {
    const size = 15;
    let b = empty(size);
    for (let c = 3; c <= 6; c++) b = applyMark(b, idx(size, 2, c), 1); // 4 marks
    expect(winnerAround(b, size, idx(size, 2, 6))).toBe(0);
  });

  it("does not wrap around the right edge", () => {
    const size = 15;
    let b = empty(size);
    // cols 13,14 of row 3 and cols 0,1,2 of row 4 are NOT contiguous.
    b = applyMark(b, idx(size, 3, 13), 1);
    b = applyMark(b, idx(size, 3, 14), 1);
    b = applyMark(b, idx(size, 4, 0), 1);
    b = applyMark(b, idx(size, 4, 1), 1);
    b = applyMark(b, idx(size, 4, 2), 1);
    expect(winnerAround(b, size, idx(size, 4, 2))).toBe(0);
  });

  it("isFull is true only when no empty cell remains", () => {
    expect(isFull(empty(3))).toBe(false);
    expect(isFull(new Array(9).fill(1))).toBe(true);
  });

  it("returns 0 for an empty / out-of-range last index", () => {
    expect(winnerAround(empty(15), 15, -1)).toBe(0);
    expect(winnerAround(empty(15), 15, 0)).toBe(0); // cell is empty
  });

  it("winningLine returns the cells of the 5-run through the last move", () => {
    const size = 15;
    let b = empty(size);
    for (let c = 3; c <= 7; c++) b = applyMark(b, idx(size, 2, c), 1);
    const line = winningLine(b, size, idx(size, 2, 7)).sort((x, y) => x - y);
    expect(line).toEqual([3, 4, 5, 6, 7].map((c) => idx(size, 2, c)));
  });

  it("winningLine is empty when the last move does not complete five", () => {
    const size = 15;
    let b = empty(size);
    for (let c = 3; c <= 6; c++) b = applyMark(b, idx(size, 2, c), 1); // only four
    expect(winningLine(b, size, idx(size, 2, 6))).toEqual([]);
  });
});
