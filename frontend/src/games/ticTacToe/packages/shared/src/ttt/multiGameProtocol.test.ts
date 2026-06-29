import { describe, expect, it } from "bun:test";
import { protocols } from "sui-tunnel-ts";
import {
  MultiGameTicTacToeProtocol,
  type MultiGameTicTacToeState,
} from "./multiGameProtocol";

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

// Drive A to a column win (cells 0,3,6) while B plays elsewhere (1,4). After A's
// third mark the inner game is terminal; returns the post-win session state.
function playAWin(
  proto: MultiGameTicTacToeProtocol,
  start: MultiGameTicTacToeState,
  saltOffset: number = 0,
): MultiGameTicTacToeState {
  let s = proto.applyMove(
    start,
    { cell: 0, salt: testSalt(saltOffset + 0) },
    "A",
  );
  s = proto.applyMove(s, { cell: 1, salt: testSalt(saltOffset + 1) }, "B");
  s = proto.applyMove(s, { cell: 3, salt: testSalt(saltOffset + 2) }, "A");
  s = proto.applyMove(s, { cell: 4, salt: testSalt(saltOffset + 3) }, "B");
  s = proto.applyMove(s, { cell: 6, salt: testSalt(saltOffset + 4) }, "A");
  return s;
}

describe("MultiGameTicTacToeProtocol", () => {
  it("is not terminal after a single finished game when maxGames > 1", () => {
    const proto = new MultiGameTicTacToeProtocol(3, 10n);
    const s = playAWin(proto, proto.initialState(ctx(100n, 100n)));
    expect(proto.isTerminal(s)).toBe(false);
    expect(s.inner.winner).toBe(1);
  });

  it("advances to a fresh board on a move once a game has finished", () => {
    const proto = new MultiGameTicTacToeProtocol(3, 10n);
    let s = playAWin(proto, proto.initialState(ctx(100n, 100n)));
    const balBefore = proto.balances(s);
    s = proto.applyMove(s, { cell: 0, salt: testSalt(10) }, "A"); // advance trigger
    expect(s.gamesPlayed).toBe(1);
    expect(s.inner.winner).toBe(0);
    expect(s.inner.movesCount).toBe(0);
    expect(s.inner.board.every((c) => c === 0)).toBe(true);
    // Balances carry forward verbatim across the reset.
    expect(proto.balances(s)).toEqual(balBefore);
  });

  it("becomes terminal only after the last of N games", () => {
    const proto = new MultiGameTicTacToeProtocol(2, 10n);
    let s = playAWin(proto, proto.initialState(ctx(100n, 100n)));
    expect(proto.isTerminal(s)).toBe(false); // game 1 of 2 done
    s = proto.applyMove(s, { cell: 0, salt: testSalt(10) }, "A"); // advance to game 2
    s = playAWin(proto, s, 20);
    expect(proto.isTerminal(s)).toBe(true); // game 2 of 2 done -> settle
  });

  it("conserves the locked total across every game (A wins both)", () => {
    const proto = new MultiGameTicTacToeProtocol(2, 10n);
    const total = 200n;
    let s = playAWin(proto, proto.initialState(ctx(100n, 100n)));
    let bal = proto.balances(s);
    expect(bal.a + bal.b).toBe(total);
    expect(bal.a).toBe(110n); // A won game 1: +10 stake
    s = proto.applyMove(s, { cell: 0, salt: testSalt(10) }, "A");
    s = playAWin(proto, s, 20);
    bal = proto.balances(s);
    expect(bal.a + bal.b).toBe(total);
    expect(bal.a).toBe(120n); // A won game 2: +10 more
  });

  it("throws on an advance move once the session is terminal", () => {
    const proto = new MultiGameTicTacToeProtocol(1, 10n);
    const s = playAWin(proto, proto.initialState(ctx(100n, 100n)));
    expect(proto.isTerminal(s)).toBe(true);
    expect(() =>
      proto.applyMove(s, { cell: 0, salt: testSalt(10) }, "A"),
    ).toThrow();
  });

  it("delegates illegal mid-game moves to the inner protocol (throws)", () => {
    const proto = new MultiGameTicTacToeProtocol(3, 10n);
    const s0 = proto.initialState(ctx(100n, 100n));
    const s1 = proto.applyMove(s0, { cell: 0, salt: testSalt(0) }, "A");
    expect(() =>
      proto.applyMove(s1, { cell: 0, salt: testSalt(1) }, "B"),
    ).toThrow(); // occupied
    expect(() =>
      proto.applyMove(s1, { cell: 1, salt: testSalt(1) }, "A"),
    ).toThrow(); // not A's turn
  });

  it("becomes terminal early when a side can no longer cover the stake", () => {
    // B starts with exactly one stake; after losing game 1, B has 0 and can't fund.
    const proto = new MultiGameTicTacToeProtocol(10, 100n);
    const s = playAWin(proto, proto.initialState(ctx(100n, 100n)));
    expect(proto.balances(s)).toEqual({ a: 200n, b: 0n });
    expect(proto.isTerminal(s)).toBe(true); // bankruptcy stops play before maxGames
  });

  it("encodeState is deterministic and distinguishes gamesPlayed", () => {
    const proto = new MultiGameTicTacToeProtocol(3, 10n);
    const s = playAWin(proto, proto.initialState(ctx(100n, 100n)));
    const enc1 = proto.encodeState(s);
    const enc2 = proto.encodeState({ ...s, inner: { ...s.inner } });
    expect(enc1).toEqual(enc2); // same logical state -> identical bytes

    const advanced = proto.applyMove(s, { cell: 0, salt: testSalt(10) }, "A");
    // gamesPlayed differs, so the encoding must differ even for an empty board.
    expect(proto.encodeState(advanced)).not.toEqual(enc1);
  });
});
