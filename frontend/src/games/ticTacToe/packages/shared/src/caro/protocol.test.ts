import { describe, expect, it } from "bun:test";
import { protocols } from "sui-tunnel-ts";
import { CaroProtocol, type CaroState } from "./protocol";

const ctx = (a: bigint, b: bigint): protocols.ProtocolContext => ({
  tunnelId: "0xtest",
  initialBalances: { a, b },
});

/** A fixed 16-byte salt for deterministic tests. Parameterized by index to vary per move. */
function testSalt(index: number = 0): Uint8Array {
  const s = new Uint8Array(16);
  s[0] = index & 0xff;
  s[1] = (index >> 8) & 0xff;
  return s;
}

// Place A at row 0 cols 0..4 (interleaving B elsewhere) to make a horizontal 5.
function playAFive(proto: CaroProtocol, s0: CaroState): CaroState {
  let s = s0;
  const N = s0.size;
  let i = 0;
  for (let k = 0; k < 4; k++) {
    s = proto.applyMove(s, { cell: 0 * N + k, salt: testSalt(i++) }, "A"); // A extends row 0
    s = proto.applyMove(s, { cell: 5 * N + k, salt: testSalt(i++) }, "B"); // B plays harmlessly on row 5
  }
  s = proto.applyMove(s, { cell: 0 * N + 4, salt: testSalt(i++) }, "A"); // A's 5th -> win
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
    expect(s.moveAccumulator).toBeInstanceOf(Uint8Array);
    expect(s.moveAccumulator.length).toBe(32);
  });

  it("rejects out-of-range, occupied, and wrong-turn moves", () => {
    const proto = new CaroProtocol(15);
    const s0 = proto.initialState(ctx(1n, 1n));
    const salt = testSalt(0);
    expect(() => proto.applyMove(s0, { cell: -1, salt }, "A")).toThrow();
    expect(() => proto.applyMove(s0, { cell: 225, salt }, "A")).toThrow();
    expect(() => proto.applyMove(s0, { cell: 0, salt }, "B")).toThrow(); // A starts
    const s1 = proto.applyMove(s0, { cell: 0, salt: testSalt(0) }, "A");
    expect(() => proto.applyMove(s1, { cell: 0, salt: testSalt(1) }, "B")).toThrow(); // occupied
    expect(() => proto.applyMove(s1, { cell: 1, salt: testSalt(1) }, "A")).toThrow(); // not A's turn
  });

  it("rejects a salt shorter than 16 bytes", () => {
    const proto = new CaroProtocol(15);
    const s = proto.initialState(ctx(1n, 1n));
    const shortSalt = new Uint8Array(15);
    expect(() => proto.applyMove(s, { cell: 0, salt: shortSalt }, "A")).toThrow(/salt/);
  });

  it("a winning move sets winner and makes the state terminal", () => {
    const proto = new CaroProtocol(15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(s.winner).toBe(1);
    expect(proto.isTerminal(s)).toBe(true);
    expect(() => proto.applyMove(s, { cell: 100, salt: testSalt(0) }, "B")).toThrow(); // game over
  });

  it("declares a draw when the board fills with no five", () => {
    // 3x3 can never make 5, so a full board is always a draw — handy for the test.
    const proto = new CaroProtocol(3);
    let s = proto.initialState(ctx(1n, 1n));
    const order: Array<[number, "A" | "B"]> = [
      [0, "A"],
      [1, "B"],
      [2, "A"],
      [4, "B"],
      [3, "A"],
      [5, "B"],
      [7, "A"],
      [6, "B"],
      [8, "A"],
    ];
    for (const [i, [cell, by]] of order.entries()) {
      s = proto.applyMove(s, { cell, salt: testSalt(i) }, by);
    }
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
    expect(p15.encodeState(s0)).toEqual(
      p15.encodeState({ ...s0, board: s0.board.slice() }),
    );
    const s1 = p15.applyMove(s0, { cell: 0, salt: testSalt(0) }, "A");
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

  it("staked: shifts stake from loser to winner on a five-in-a-row", () => {
    const proto = new CaroProtocol(19, 10n);
    const s = playAFive(proto, proto.initialState(ctx(100n, 100n)));
    expect(s.winner).toBe(1); // A wins
    expect(s.balanceA).toBe(110n);
    expect(s.balanceB).toBe(90n);
    expect(s.balanceA + s.balanceB).toBe(s.total); // invariant holds
  });

  it("staked: clamps stake to loser balance when stake exceeds balance", () => {
    // Stake of 200n but loser only has 50n — only 50n should shift.
    const proto = new CaroProtocol(19, 200n);
    const s = playAFive(proto, proto.initialState(ctx(150n, 50n)));
    expect(s.winner).toBe(1); // A wins; B is the loser with 50n
    expect(s.balanceA).toBe(200n); // 150 + 50
    expect(s.balanceB).toBe(0n);
    expect(s.balanceA + s.balanceB).toBe(s.total);
  });

  it("staked: a draw leaves balances unchanged", () => {
    // 3x3 fills with no five — always a draw.
    const proto = new CaroProtocol(3, 10n);
    let s = proto.initialState(ctx(100n, 100n));
    const order: Array<[number, "A" | "B"]> = [
      [0, "A"],
      [1, "B"],
      [2, "A"],
      [4, "B"],
      [3, "A"],
      [5, "B"],
      [7, "A"],
      [6, "B"],
      [8, "A"],
    ];
    for (const [i, [cell, by]] of order.entries()) {
      s = proto.applyMove(s, { cell, salt: testSalt(i) }, by);
    }
    expect(s.winner).toBe(3); // draw
    expect(s.balanceA).toBe(100n);
    expect(s.balanceB).toBe(100n);
  });

  it("staked: stake field is present in initial state and equals clamped value", () => {
    const proto = new CaroProtocol(19, 10n);
    const s = proto.initialState(ctx(100n, 100n));
    expect(s.stake).toBe(10n);
    expect(s.total).toBe(200n);
  });

  it("moveAccumulator: same moves+salts produce the same accumulator", () => {
    const proto = new CaroProtocol(15);
    const s0a = proto.initialState(ctx(1n, 1n));
    const s0b = proto.initialState(ctx(1n, 1n));
    const sa = proto.applyMove(s0a, { cell: 7, salt: testSalt(0) }, "A");
    const sb = proto.applyMove(s0b, { cell: 7, salt: testSalt(0) }, "A");
    expect(sa.moveAccumulator).toEqual(sb.moveAccumulator);
    expect(proto.encodeState(sa)).toEqual(proto.encodeState(sb));
  });

  it("moveAccumulator: different cells produce different accumulators", () => {
    const proto = new CaroProtocol(15);
    const s0 = proto.initialState(ctx(1n, 1n));
    const s1 = proto.applyMove(s0, { cell: 0, salt: testSalt(0) }, "A");
    const s2 = proto.applyMove(s0, { cell: 7, salt: testSalt(0) }, "A");
    expect(s1.moveAccumulator).not.toEqual(s2.moveAccumulator);
  });

  it("moveAccumulator: different salts produce different accumulators", () => {
    const proto = new CaroProtocol(15);
    const s0 = proto.initialState(ctx(1n, 1n));
    const s1 = proto.applyMove(s0, { cell: 7, salt: testSalt(0) }, "A");
    const s2 = proto.applyMove(s0, { cell: 7, salt: testSalt(99) }, "A");
    expect(s1.moveAccumulator).not.toEqual(s2.moveAccumulator);
  });

  it("moveAccumulator: accumulator advances after each move", () => {
    const proto = new CaroProtocol(15);
    const s0 = proto.initialState(ctx(1n, 1n));
    const s1 = proto.applyMove(s0, { cell: 0, salt: testSalt(0) }, "A");
    const s2 = proto.applyMove(s1, { cell: 7, salt: testSalt(1) }, "B");
    expect(s0.moveAccumulator).not.toEqual(s1.moveAccumulator);
    expect(s1.moveAccumulator).not.toEqual(s2.moveAccumulator);
  });

  it("moveAccumulator: encodeState appends the 32-byte accumulator", () => {
    const proto = new CaroProtocol(15);
    const s = proto.initialState(ctx(1n, 1n));
    const enc = proto.encodeState(s);
    const tail = enc.slice(enc.length - 32);
    expect(tail).toEqual(s.moveAccumulator);
  });

  it("applyMove is pure (does not mutate input state)", () => {
    const proto = new CaroProtocol(15);
    const s = proto.initialState(ctx(1n, 1n));
    const boardBefore = s.board.slice();
    const accBefore = s.moveAccumulator.slice();
    proto.applyMove(s, { cell: 0, salt: testSalt(0) }, "A");
    expect(s.board).toEqual(boardBefore);
    expect(s.moveAccumulator).toEqual(accBefore);
    expect(s.turn).toBe("A");
    expect(s.movesCount).toBe(0);
  });
});
