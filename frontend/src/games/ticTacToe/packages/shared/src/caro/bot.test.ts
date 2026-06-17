import { describe, expect, it } from "bun:test";
import { CaroProtocol } from "./protocol";
import { pickCaroMove } from "./bot";

const ctx = { tunnelId: "0xtest", initialBalances: { a: 1n, b: 1n } };
const det = () => 0; // deterministic rng for tests
const idx = (size: number, r: number, c: number) => r * size + c;

describe("pickCaroMove", () => {
  it("opens at the center on an empty board", () => {
    const s = new CaroProtocol(15).initialState(ctx);
    const center = Math.floor((15 * 15) / 2);
    expect(pickCaroMove(s, "A", det, "strong")).toBe(center);
  });

  it("takes the immediate winning move (completes five)", () => {
    const proto = new CaroProtocol(15);
    let s = proto.initialState(ctx);
    // A at row 7 cols 3..6 (open four); B harmless on row 9. A to move.
    for (let k = 0; k < 4; k++) {
      s = proto.applyMove(s, { cell: idx(15, 7, 3 + k) }, "A");
      if (k < 3) s = proto.applyMove(s, { cell: idx(15, 9, k) }, "B");
    }
    // Now it's B's turn after 4 A-moves + 3 B-moves -> make it A's turn:
    s = proto.applyMove(s, { cell: idx(15, 9, 3) }, "B");
    expect(s.turn).toBe("A");
    const move = pickCaroMove(s, "A", det, "strong");
    // Completing the run at col 2 or col 7 both make five.
    expect([idx(15, 7, 2), idx(15, 7, 7)]).toContain(move);
  });

  it("blocks the opponent's open four when it has no win of its own", () => {
    const proto = new CaroProtocol(15);
    let s = proto.initialState(ctx);
    // B builds an open four on row 7 cols 3..6; A plays scattered, no threat.
    s = proto.applyMove(s, { cell: idx(15, 0, 0) }, "A");
    s = proto.applyMove(s, { cell: idx(15, 7, 3) }, "B");
    s = proto.applyMove(s, { cell: idx(15, 0, 2) }, "A");
    s = proto.applyMove(s, { cell: idx(15, 7, 4) }, "B");
    s = proto.applyMove(s, { cell: idx(15, 0, 4) }, "A");
    s = proto.applyMove(s, { cell: idx(15, 7, 5) }, "B");
    s = proto.applyMove(s, { cell: idx(15, 0, 6) }, "A");
    s = proto.applyMove(s, { cell: idx(15, 7, 6) }, "B");
    expect(s.turn).toBe("A");
    const move = pickCaroMove(s, "A", det, "strong");
    expect([idx(15, 7, 2), idx(15, 7, 7)]).toContain(move); // block an open end
  });

  it("always returns a legal empty cell", () => {
    const proto = new CaroProtocol(9);
    let s = proto.initialState(ctx);
    s = proto.applyMove(s, { cell: 40 }, "A");
    const move = pickCaroMove(s, "B", det, "weak");
    expect(s.board[move]).toBe(0);
    expect(move).toBeGreaterThanOrEqual(0);
    expect(move).toBeLessThan(81);
  });

  it("throws when there is no legal move (full board)", () => {
    const proto = new CaroProtocol(3);
    let s = proto.initialState(ctx);
    // Fill the board without making five (impossible on 3x3) — ends in a draw, board full.
    const order: Array<[number, "A" | "B"]> = [
      [0, "A"], [1, "B"], [2, "A"],
      [4, "B"], [3, "A"], [5, "B"],
      [7, "A"], [6, "B"], [8, "A"],
    ];
    for (const [cell, by] of order) s = proto.applyMove(s, { cell }, by);
    expect(() => pickCaroMove(s, "A", det, "strong")).toThrow();
  });
});
