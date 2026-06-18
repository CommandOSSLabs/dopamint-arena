import { describe, expect, it } from "bun:test";
import { protocols } from "sui-tunnel-ts";
import { CaroProtocol, type CaroState } from "./protocol";

const ctx = (a: bigint, b: bigint): protocols.ProtocolContext => ({
  tunnelId: "0xtest",
  initialBalances: { a, b },
});

// Place A at row 0 cols 0..4 (interleaving B elsewhere) to make a horizontal 5.
function playAFive(proto: CaroProtocol, s0: CaroState): CaroState {
  let s = s0;
  const N = s0.size;
  for (let k = 0; k < 4; k++) {
    s = proto.applyMove(s, { cell: 0 * N + k }, "A"); // A extends row 0
    s = proto.applyMove(s, { cell: 5 * N + k }, "B"); // B plays harmlessly on row 5
  }
  s = proto.applyMove(s, { cell: 0 * N + 4 }, "A"); // A's 5th -> win
  return s;
}

describe("CaroProtocol", () => {
  it("initial state is an empty board of the configured size, A to move", () => {
    const proto = new CaroProtocol(15);
    const s = proto.initialState(ctx(1n, 1n));
    expect(s.size).toBe(15);
    expect(s.board.length).toBe(225);
    expect(s.board.every((c) => c === 0)).toBe(true);
    expect(s.turn).toBe("A");
    expect(s.winner).toBe(0);
    expect(s.lastMove).toBe(-1);
    expect(s.movesCount).toBe(0);
  });

  it("rejects out-of-range, occupied, and wrong-turn moves", () => {
    const proto = new CaroProtocol(15);
    const s0 = proto.initialState(ctx(1n, 1n));
    expect(() => proto.applyMove(s0, { cell: -1 }, "A")).toThrow();
    expect(() => proto.applyMove(s0, { cell: 225 }, "A")).toThrow();
    expect(() => proto.applyMove(s0, { cell: 0 }, "B")).toThrow(); // A starts
    const s1 = proto.applyMove(s0, { cell: 0 }, "A");
    expect(() => proto.applyMove(s1, { cell: 0 }, "B")).toThrow(); // occupied
    expect(() => proto.applyMove(s1, { cell: 1 }, "A")).toThrow(); // not A's turn
  });

  it("a winning move sets winner and makes the state terminal", () => {
    const proto = new CaroProtocol(15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(s.winner).toBe(1);
    expect(proto.isTerminal(s)).toBe(true);
    expect(() => proto.applyMove(s, { cell: 100 }, "B")).toThrow(); // game over
  });

  it("declares a draw when the board fills with no five", () => {
    // 3x3 can never make 5, so a full board is always a draw — handy for the test.
    const proto = new CaroProtocol(3);
    let s = proto.initialState(ctx(1n, 1n));
    const order: Array<[number, "A" | "B"]> = [
      [0, "A"], [1, "B"], [2, "A"],
      [4, "B"], [3, "A"], [5, "B"],
      [7, "A"], [6, "B"], [8, "A"],
    ];
    for (const [cell, by] of order) s = proto.applyMove(s, { cell }, by);
    expect(s.winner).toBe(3);
    expect(proto.isTerminal(s)).toBe(true);
  });

  it("balances are constant and sum to the locked total", () => {
    const proto = new CaroProtocol(15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(proto.balances(s)).toEqual({ a: 1n, b: 1n });
  });

  it("encodeState is deterministic, changes with the board, and bakes in size", () => {
    const p15 = new CaroProtocol(15);
    const s0 = p15.initialState(ctx(1n, 1n));
    expect(p15.encodeState(s0)).toEqual(p15.encodeState({ ...s0, board: s0.board.slice() }));
    const s1 = p15.applyMove(s0, { cell: 0 }, "A");
    expect(p15.encodeState(s1)).not.toEqual(p15.encodeState(s0));

    // Same logical empty board but different size -> different bytes.
    const p19 = new CaroProtocol(19);
    const e15 = p15.encodeState(s0);
    const e19 = p19.encodeState(p19.initialState(ctx(1n, 1n)));
    expect(e15).not.toEqual(e19);
  });

  it("does not collide with a TicTacToe encoding for an empty board", () => {
    const caro = new CaroProtocol(3);
    const ttt = new protocols.TicTacToeProtocol(0n);
    const cEnc = caro.encodeState(caro.initialState(ctx(1n, 1n)));
    const tEnc = ttt.encodeState(ttt.initialState(ctx(1n, 1n)));
    expect(cEnc).not.toEqual(tEnc); // distinct domain tags
  });
});
