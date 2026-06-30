import { test } from "node:test";
import assert from "node:assert/strict";
import { TicTacToeProtocol, TicTacToeState, TicTacToeMove } from "./ticTacToe";
import { toHex } from "../core/bytes";
import { OffchainTunnel, verifyCoSignedUpdate } from "../core/tunnel";
import { generateKeyPair, ed25519Address } from "../core/crypto";
import { Party } from "./Protocol";

const ctx = { tunnelId: "0xab", initialBalances: { a: 1000n, b: 1000n } };

/** A fixed 16-byte salt for deterministic tests. Parameterized by index to vary per move. */
function testSalt(index: number = 0): Uint8Array {
  const s = new Uint8Array(16);
  s[0] = index & 0xff;
  s[1] = (index >> 8) & 0xff;
  return s;
}

/** Apply a sequence of cells, alternating turns starting with A, using per-move salts. */
function play(
  proto: TicTacToeProtocol,
  s: TicTacToeState,
  cells: number[]
): TicTacToeState {
  let cur = s;
  for (let i = 0; i < cells.length; i++) {
    cur = proto.applyMove(cur, { cell: cells[i], salt: testSalt(i) }, cur.turn);
  }
  return cur;
}

test("initialState: empty board, A to move, balances and stake set", () => {
  const proto = new TicTacToeProtocol(100n);
  const s = proto.initialState(ctx);
  assert.deepEqual(s.board, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(s.turn, "A");
  assert.equal(s.movesCount, 0);
  assert.equal(s.winner, 0);
  assert.equal(s.balanceA, 1000n);
  assert.equal(s.balanceB, 1000n);
  assert.equal(s.total, 2000n);
  assert.equal(s.stake, 100n);
  assert.ok(s.moveAccumulator instanceof Uint8Array);
  assert.equal(s.moveAccumulator.length, 32);
  assert.ok(!proto.isTerminal(s));
});

test("initialState: stake is clamped to the smaller balance", () => {
  const proto = new TicTacToeProtocol(500n);
  const s = proto.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 300n, b: 1000n },
  });
  assert.equal(s.stake, 300n);
});

test("applyMove places marks and advances the turn", () => {
  const proto = new TicTacToeProtocol();
  let s = proto.initialState(ctx);
  s = proto.applyMove(s, { cell: 0, salt: testSalt(0) }, "A");
  assert.equal(s.board[0], 1);
  assert.equal(s.turn, "B");
  assert.equal(s.movesCount, 1);
  s = proto.applyMove(s, { cell: 4, salt: testSalt(1) }, "B");
  assert.equal(s.board[4], 2);
  assert.equal(s.turn, "A");
  assert.equal(s.movesCount, 2);
});

test("applyMove rejects wrong turn, out-of-range, occupied, and finished game", () => {
  const proto = new TicTacToeProtocol();
  const s0 = proto.initialState(ctx);
  const salt = testSalt(0);
  // Wrong turn: B cannot open.
  assert.throws(() => proto.applyMove(s0, { cell: 0, salt }, "B"));
  // Out of range.
  assert.throws(() => proto.applyMove(s0, { cell: 9, salt }, "A"));
  assert.throws(() => proto.applyMove(s0, { cell: -1, salt }, "A"));
  assert.throws(() => proto.applyMove(s0, { cell: 1.5, salt }, "A"));
  // Occupied cell.
  const s1 = proto.applyMove(s0, { cell: 0, salt: testSalt(0) }, "A");
  assert.throws(() => proto.applyMove(s1, { cell: 0, salt: testSalt(1) }, "B"));
  // Finished game: A wins top row, then any move throws.
  const won = play(proto, s0, [0, 3, 1, 4, 2]); // A:0,1,2 | B:3,4
  assert.equal(won.winner, 1);
  assert.throws(() => proto.applyMove(won, { cell: 8, salt }, "B"));
});

test("applyMove rejects a salt shorter than 16 bytes", () => {
  const proto = new TicTacToeProtocol();
  const s = proto.initialState(ctx);
  const shortSalt = new Uint8Array(15);
  assert.throws(
    () => proto.applyMove(s, { cell: 0, salt: shortSalt }, "A"),
    /salt/
  );
});

test("applyMove is pure (does not mutate input state or its board)", () => {
  const proto = new TicTacToeProtocol();
  const s = proto.initialState(ctx);
  const before = s.board.slice();
  const accBefore = s.moveAccumulator.slice();
  proto.applyMove(s, { cell: 4, salt: testSalt(0) }, "A");
  assert.deepEqual(s.board, before);
  assert.deepEqual(s.moveAccumulator, accBefore);
  assert.equal(s.turn, "A");
  assert.equal(s.movesCount, 0);
});

test("A wins: stake shifts from B to A; total conserved", () => {
  const proto = new TicTacToeProtocol(100n);
  let s = proto.initialState(ctx);
  s = play(proto, s, [0, 3, 1, 4, 2]); // A takes top row
  assert.equal(s.winner, 1);
  assert.equal(s.balanceA, 1100n);
  assert.equal(s.balanceB, 900n);
  const bal = proto.balances(s);
  assert.equal(bal.a + bal.b, 2000n);
  assert.ok(proto.isTerminal(s));
});

test("B wins: stake shifts from A to B; total conserved", () => {
  const proto = new TicTacToeProtocol(100n);
  let s = proto.initialState(ctx);
  // A:0,1,8 (no line) ; B:3,4,5 (middle row)
  s = play(proto, s, [0, 3, 1, 4, 8, 5]);
  assert.equal(s.winner, 2);
  assert.equal(s.balanceA, 900n);
  assert.equal(s.balanceB, 1100n);
  const bal = proto.balances(s);
  assert.equal(bal.a + bal.b, 2000n);
});

test("draw: balances unchanged, terminal", () => {
  const proto = new TicTacToeProtocol(100n);
  let s = proto.initialState(ctx);
  // A board: X O X / X X O / O X O  -> full board, no line.
  // Sequence of cells (A first): 0,1,2,4,3,5,7,6,8
  s = play(proto, s, [0, 1, 2, 4, 3, 5, 7, 6, 8]);
  assert.equal(s.movesCount, 9);
  assert.equal(s.winner, 3);
  assert.equal(s.balanceA, 1000n);
  assert.equal(s.balanceB, 1000n);
  assert.ok(proto.isTerminal(s));
});

test("stake shift is clamped to the loser's available balance", () => {
  const proto = new TicTacToeProtocol(500n);
  // B starts with only 200; stake clamps to 200.
  let s = proto.initialState({
    tunnelId: "0xab",
    initialBalances: { a: 1000n, b: 200n },
  });
  assert.equal(s.stake, 200n);
  s = play(proto, s, [0, 3, 1, 4, 2]); // A wins
  assert.equal(s.winner, 1);
  assert.equal(s.balanceA, 1200n);
  assert.equal(s.balanceB, 0n);
  assert.equal(proto.balances(s).a + proto.balances(s).b, 1200n);
});

test("encodeState is deterministic and changes with state", () => {
  const proto = new TicTacToeProtocol();
  const s0 = proto.initialState(ctx);
  const s1 = proto.applyMove(s0, { cell: 0, salt: testSalt(0) }, "A");
  assert.equal(toHex(proto.encodeState(s0)), toHex(proto.encodeState(s0)));
  assert.notEqual(toHex(proto.encodeState(s0)), toHex(proto.encodeState(s1)));
  // Different cell -> different encoding.
  const s2 = proto.applyMove(s0, { cell: 1, salt: testSalt(0) }, "A");
  assert.notEqual(toHex(proto.encodeState(s1)), toHex(proto.encodeState(s2)));
});

test("encodeState includes the v2 domain tag", () => {
  const proto = new TicTacToeProtocol();
  const s = proto.initialState(ctx);
  const enc = proto.encodeState(s);
  const domainStr = new TextDecoder().decode(enc.slice(0, 28));
  assert.equal(domainStr, "sui_tunnel::proto::tic_tac_t");
  // Ensure "v2" is in the domain
  const fullDomain = new TextDecoder().decode(enc.slice(0, 35));
  assert.ok(fullDomain.includes("v2"), `expected v2 in domain, got: ${fullDomain}`);
});

test("moveAccumulator: same moves+salts produce the same accumulator", () => {
  const proto = new TicTacToeProtocol();
  // Simulate two seats applying identical moves
  const s0a = proto.initialState(ctx);
  const s0b = proto.initialState(ctx);
  const sa = proto.applyMove(s0a, { cell: 4, salt: testSalt(0) }, "A");
  const sb = proto.applyMove(s0b, { cell: 4, salt: testSalt(0) }, "A");
  assert.equal(toHex(sa.moveAccumulator), toHex(sb.moveAccumulator));
  assert.equal(toHex(proto.encodeState(sa)), toHex(proto.encodeState(sb)));
});

test("moveAccumulator: different cells produce different accumulators", () => {
  const proto = new TicTacToeProtocol();
  const s0 = proto.initialState(ctx);
  const s1 = proto.applyMove(s0, { cell: 0, salt: testSalt(0) }, "A");
  const s2 = proto.applyMove(s0, { cell: 4, salt: testSalt(0) }, "A");
  // Tamper: same salt, different cell -> different accumulator
  assert.notEqual(toHex(s1.moveAccumulator), toHex(s2.moveAccumulator));
});

test("moveAccumulator: different salts produce different accumulators", () => {
  const proto = new TicTacToeProtocol();
  const s0 = proto.initialState(ctx);
  const s1 = proto.applyMove(s0, { cell: 4, salt: testSalt(0) }, "A");
  const s2 = proto.applyMove(s0, { cell: 4, salt: testSalt(99) }, "A");
  assert.notEqual(toHex(s1.moveAccumulator), toHex(s2.moveAccumulator));
});

test("moveAccumulator: accumulator advances after each move", () => {
  const proto = new TicTacToeProtocol();
  const s0 = proto.initialState(ctx);
  const s1 = proto.applyMove(s0, { cell: 0, salt: testSalt(0) }, "A");
  const s2 = proto.applyMove(s1, { cell: 4, salt: testSalt(1) }, "B");
  // Each move must change the accumulator
  assert.notEqual(toHex(s0.moveAccumulator), toHex(s1.moveAccumulator));
  assert.notEqual(toHex(s1.moveAccumulator), toHex(s2.moveAccumulator));
});

test("moveAccumulator: encodeState appends the 32-byte accumulator", () => {
  const proto = new TicTacToeProtocol();
  const s = proto.initialState(ctx);
  const enc = proto.encodeState(s);
  // The last 32 bytes of encodeState must equal the moveAccumulator
  const tail = enc.slice(enc.length - 32);
  assert.equal(toHex(tail), toHex(s.moveAccumulator));
});

test("randomMove yields only legal moves and never returns for the off-turn party", () => {
  const proto = new TicTacToeProtocol(50n);
  let s = proto.initialState(ctx);
  // Off-turn party gets null.
  assert.equal(proto.randomMove(s, "B", Math.random), null);
  let guard = 0;
  while (s.winner === 0 && guard++ < 100) {
    const by: Party = s.turn;
    const m = proto.randomMove(s, by, Math.random);
    assert.ok(m, "active party must have a legal move while game is live");
    assert.ok((m as TicTacToeMove).cell >= 0 && (m as TicTacToeMove).cell <= 8);
    assert.equal(s.board[(m as TicTacToeMove).cell], 0); // empty
    assert.ok((m as TicTacToeMove).salt instanceof Uint8Array);
    assert.ok((m as TicTacToeMove).salt.length >= 16);
    s = proto.applyMove(s, m as TicTacToeMove, by);
    const bal = proto.balances(s);
    assert.equal(bal.a + bal.b, 2000n);
    assert.ok(bal.a >= 0n && bal.b >= 0n);
  }
  assert.notEqual(s.winner, 0); // game terminates within 9 moves
  assert.equal(proto.randomMove(s, s.turn, Math.random), null); // terminal -> null
});

test("end-to-end self-play tunnel: latest co-signed update verifies", () => {
  const proto = new TicTacToeProtocol(100n);
  const a = generateKeyPair();
  const b = generateKeyPair();
  const t = OffchainTunnel.selfPlay(
    proto,
    "0x" + "33".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: 1000n, b: 1000n }
  );
  // A wins the top row: cells 0,3,1,4,2 alternating A/B.
  const cells = [0, 3, 1, 4, 2];
  for (let i = 0; i < cells.length; i++) {
    const by: Party = i % 2 === 0 ? "A" : "B";
    t.step({ cell: cells[i], salt: testSalt(i) }, by);
  }
  assert.equal(t.state.winner, 1);
  assert.equal(t.state.balanceA, 1100n);
  assert.equal(t.state.balanceB, 900n);
  assert.ok(t.latest);
  assert.ok(
    verifyCoSignedUpdate(
      t.latest!,
      { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
      { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme }
    )
  );
});
