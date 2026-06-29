import { describe, expect, it } from "bun:test";
import { protocols } from "sui-tunnel-ts";
import { MultiGameCaroProtocol, type MultiGameCaroState } from "./protocol";

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

// A makes a horizontal 5 on row 0; B plays harmlessly on row 5. Returns post-win state.
function playAFive(
  proto: MultiGameCaroProtocol,
  s0: MultiGameCaroState,
): MultiGameCaroState {
  let s = s0;
  const N = s0.inner.size;
  let i = 0;
  for (let k = 0; k < 4; k++) {
    s = proto.applyMove(s, { cell: 0 * N + k, salt: testSalt(i++) }, "A");
    s = proto.applyMove(s, { cell: 5 * N + k, salt: testSalt(i++) }, "B");
  }
  return proto.applyMove(s, { cell: 0 * N + 4, salt: testSalt(i++) }, "A");
}

describe("MultiGameCaroProtocol", () => {
  it("is not terminal after one finished game when maxGames > 1", () => {
    const proto = new MultiGameCaroProtocol(3, 15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(proto.isTerminal(s)).toBe(false);
    expect(s.inner.winner).toBe(1);
  });

  it("advances to a fresh board carrying balances forward", () => {
    const proto = new MultiGameCaroProtocol(3, 15);
    let s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    const balBefore = proto.balances(s);
    s = proto.applyMove(s, { cell: 0, salt: testSalt(0) }, "A"); // advance trigger
    expect(s.gamesPlayed).toBe(1);
    expect(s.inner.winner).toBe(0);
    expect(s.inner.movesCount).toBe(0);
    expect(s.inner.board.every((c) => c === 0)).toBe(true);
    expect(proto.balances(s)).toEqual(balBefore);
  });

  it("becomes terminal only after the last of N games", () => {
    const proto = new MultiGameCaroProtocol(2, 15);
    let s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(proto.isTerminal(s)).toBe(false);
    s = proto.applyMove(s, { cell: 0, salt: testSalt(0) }, "A"); // advance to game 2
    s = playAFive(proto, s);
    expect(proto.isTerminal(s)).toBe(true);
  });

  it("throws on an advance move once the session is terminal", () => {
    const proto = new MultiGameCaroProtocol(1, 15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(proto.isTerminal(s)).toBe(true);
    expect(() => proto.applyMove(s, { cell: 0, salt: testSalt(0) }, "A")).toThrow();
  });

  it("encodeState is deterministic and distinguishes gamesPlayed", () => {
    const proto = new MultiGameCaroProtocol(3, 15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    const enc1 = proto.encodeState(s);
    expect(proto.encodeState({ ...s, inner: { ...s.inner } })).toEqual(enc1);
    const advanced = proto.applyMove(s, { cell: 0, salt: testSalt(0) }, "A");
    expect(proto.encodeState(advanced)).not.toEqual(enc1);
  });

  it("staked: carries shifted balances into the next game", () => {
    const proto = new MultiGameCaroProtocol(3, 15, 10n);
    let s = playAFive(proto, proto.initialState(ctx(100n, 100n)));
    expect(s.inner.winner).toBe(1);
    expect(proto.balances(s)).toEqual({ a: 110n, b: 90n });
    // Advance to game 2 and verify balances carry forward.
    s = proto.applyMove(s, { cell: 0, salt: testSalt(0) }, "A");
    expect(s.gamesPlayed).toBe(1);
    expect(proto.balances(s)).toEqual({ a: 110n, b: 90n });
  });

  it("staked: terminal when a side cannot fund the next game", () => {
    // stake=100, A starts with 150, B starts with 50. After one A win, B has 0n.
    const proto = new MultiGameCaroProtocol(3, 15, 100n);
    const s = playAFive(proto, proto.initialState(ctx(150n, 50n)));
    expect(s.inner.winner).toBe(1);
    // B has 0n — can't fund another stake of 100n, so session must be terminal.
    expect(proto.isTerminal(s)).toBe(true);
  });

  it("staked (0n): always fundable when stake is zero", () => {
    const proto = new MultiGameCaroProtocol(3, 15, 0n);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    // Not terminal (maxGames=3, only 1 played).
    expect(proto.isTerminal(s)).toBe(false);
  });
});
