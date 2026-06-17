import assert from "node:assert/strict";
import { test } from "node:test";
import { concatBytes, toHex } from "../core/bytes";
import { ed25519Address, generateKeyPair, verify } from "../core/crypto";
import { OffchainTunnel, verifyCoSignedUpdate } from "../core/tunnel";
import {
  addressToBytes32,
  serializeSettlement,
  u64ToBeBytes,
} from "../core/wire";
import { Party, TicTacToeMove } from "./index";
import {
  MultiGameTicTacToeProtocol,
  MultiGameTicTacToeState,
} from "./multiGameTicTacToe";

const TID = "0x" + "ab".repeat(32);
const ctx = { tunnelId: TID, initialBalances: { a: 100n, b: 100n } };

function fresh(
  target = 0,
  wager = 10n,
): {
  proto: MultiGameTicTacToeProtocol;
  s: MultiGameTicTacToeState;
} {
  const proto = new MultiGameTicTacToeProtocol(target, wager);
  return { proto, s: proto.initialState(ctx) };
}

/** Apply a full game where A wins the top row. */
function playGameAWins(
  proto: MultiGameTicTacToeProtocol,
  s: MultiGameTicTacToeState,
): MultiGameTicTacToeState {
  const moves: [TicTacToeMove, Party][] = [
    [{ cell: 0 }, "A"],
    [{ cell: 3 }, "B"],
    [{ cell: 1 }, "A"],
    [{ cell: 4 }, "B"],
    [{ cell: 2 }, "A"], // A completes the top row
  ];
  for (const [m, by] of moves) s = proto.applyMove(s, m, by);
  return s;
}

/** Apply a full game where B wins the top row. */
function playGameBWins(
  proto: MultiGameTicTacToeProtocol,
  s: MultiGameTicTacToeState,
): MultiGameTicTacToeState {
  const moves: [TicTacToeMove, Party][] = [
    [{ cell: 3 }, "A"],
    [{ cell: 0 }, "B"],
    [{ cell: 4 }, "A"],
    [{ cell: 1 }, "B"],
    [{ cell: 6 }, "A"],
    [{ cell: 2 }, "B"], // B completes the top row
  ];
  for (const [m, by] of moves) s = proto.applyMove(s, m, by);
  return s;
}

test("initialState seeds an even ledger and empty board", () => {
  const { proto, s } = fresh();
  assert.equal(s.gamesPlayed, 0);
  assert.equal(s.balanceA, 100n);
  assert.equal(s.balanceB, 100n);
  assert.equal(s.total, 200n);
  assert.equal(s.wager, 10n);
  assert.equal(s.turn, "A");
  assert.deepEqual(s.board, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(!proto.isTerminal(s));
});

test("a non-winning move advances the board without moving money", () => {
  const { proto, s } = fresh();
  const s1 = proto.applyMove(s, { cell: 4 }, "A");
  assert.equal(s1.movesCount, 1);
  assert.equal(s1.turn, "B");
  assert.equal(s1.gamesPlayed, 0);
  assert.equal(s1.balanceA, 100n);
  assert.equal(s1.balanceB, 100n);
});

test("a completed game folds the result and resets the board", () => {
  const { proto } = fresh();
  let s = proto.initialState(ctx);
  s = playGameAWins(proto, s);
  assert.equal(s.gamesPlayed, 1);
  assert.equal(s.winsA, 1);
  assert.equal(s.balanceA, 110n);
  assert.equal(s.balanceB, 90n);
  assert.equal(s.lastWinner, 1);
  assert.deepEqual(s.board, [0, 0, 0, 0, 0, 0, 0, 0, 0]); // reset
  assert.equal(s.turn, "A");
});

test("many games accumulate into the running balance; pot is conserved", () => {
  const { proto } = fresh();
  let s = proto.initialState(ctx);
  s = playGameAWins(proto, s); // A: 110/90
  s = playGameBWins(proto, s); // back to 100/100
  s = playGameAWins(proto, s); // A: 110/90
  assert.equal(s.gamesPlayed, 3);
  assert.equal(s.winsA, 2);
  assert.equal(s.winsB, 1);
  assert.equal(s.balanceA, 110n);
  assert.equal(s.balanceB, 90n);
  assert.equal(s.balanceA + s.balanceB, s.total);
});

test("wager is clamped so a balance can never go negative", () => {
  // Start lopsided: B has only 5; a big wager can take at most 5.
  const proto = new MultiGameTicTacToeProtocol(0, 1000n);
  let s = proto.initialState({
    tunnelId: TID,
    initialBalances: { a: 195n, b: 5n },
  });
  // wager is clamped at open to min(195,5) = 5.
  assert.equal(s.wager, 5n);
  s = playGameAWins(proto, s);
  assert.equal(s.balanceA, 200n);
  assert.equal(s.balanceB, 0n);
  assert.equal(s.balanceA + s.balanceB, 200n);
});

test("encodeState matches the canonical Move layout, byte for byte", () => {
  const { proto } = fresh();
  let s = proto.initialState(ctx);
  s = playGameAWins(proto, s); // games=1, winsA=1, bal 110/90, board reset

  const expected = concatBytes([
    new TextEncoder().encode("multi_tic_tac_toe::session"),
    addressToBytes32(TID),
    Uint8Array.from(s.board),
    Uint8Array.of(s.movesCount),
    u64ToBeBytes(s.gamesPlayed),
    u64ToBeBytes(s.winsA),
    u64ToBeBytes(s.winsB),
    u64ToBeBytes(s.draws),
    u64ToBeBytes(s.balanceA),
    u64ToBeBytes(s.balanceB),
  ]);
  assert.equal(toHex(proto.encodeState(s)), toHex(expected));

  // Sensitivity: a different running balance changes the encoding.
  const s2 = { ...s, balanceA: 120n, balanceB: 80n };
  assert.notEqual(toHex(proto.encodeState(s)), toHex(proto.encodeState(s2)));
});

test("balances always sum to total across a long random self-play sequence", () => {
  const { proto } = fresh();
  let s = proto.initialState(ctx);
  let x = 0.123456789;
  const rng = () => (x = (x * 16807) % 1) || 0.5;
  for (let i = 0; i < 5000; i++) {
    const by: Party = s.turn;
    const m = proto.randomMove(s, by, rng);
    assert.ok(m, "the on-turn party always has a legal move");
    s = proto.applyMove(s, m!, by);
    assert.equal(s.balanceA + s.balanceB, 200n);
    assert.ok(s.balanceA >= 0n && s.balanceB >= 0n);
  }
  assert.ok(s.gamesPlayed > 0);
});

test("targetGames makes the session terminal and rejects further play", () => {
  const proto = new MultiGameTicTacToeProtocol(2, 10n);
  let s = proto.initialState(ctx);
  s = playGameAWins(proto, s);
  assert.ok(!proto.isTerminal(s));
  s = playGameAWins(proto, s);
  assert.equal(s.gamesPlayed, 2);
  assert.ok(proto.isTerminal(s));
  assert.throws(() => proto.applyMove(s, { cell: 0 }, "A"));
});

test("end-to-end tunnel: many games, single monotonic nonce, one verified settlement", () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const proto = new MultiGameTicTacToeProtocol(0, 10n);
  const t = OffchainTunnel.selfPlay(
    proto,
    "0x" + "33".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: 100n, b: 100n },
  );

  const stepGame = (moves: [TicTacToeMove, Party][]) => {
    for (const [m, by] of moves) t.step(m, by);
  };
  const A_WINS: [TicTacToeMove, Party][] = [
    [{ cell: 0 }, "A"],
    [{ cell: 3 }, "B"],
    [{ cell: 1 }, "A"],
    [{ cell: 4 }, "B"],
    [{ cell: 2 }, "A"],
  ];

  // Play 4 games, all won by A.
  stepGame(A_WINS);
  stepGame(A_WINS);
  stepGame(A_WINS);
  stepGame(A_WINS);

  // A single, strictly-increasing per-tunnel nonce spans every move of every game.
  assert.equal(t.nonce, 20n); // 4 games * 5 moves
  assert.equal(t.state.gamesPlayed, 4);
  assert.equal(t.state.winsA, 4);
  assert.equal(t.state.balanceA, 140n);
  assert.equal(t.state.balanceB, 60n);

  // The latest co-signed update (the artifact used for a dispute) verifies.
  assert.ok(t.latest);
  assert.ok(
    verifyCoSignedUpdate(
      t.latest!,
      { publicKey: t.partyA.publicKey, scheme: t.partyA.scheme },
      { publicKey: t.partyB.publicKey, scheme: t.partyB.scheme },
    ),
  );

  // ONE cooperative settlement carries the cumulative result; both real sigs verify.
  const cs = t.buildSettlement(0n);
  assert.equal(cs.settlement.partyABalance, 140n);
  assert.equal(cs.settlement.partyBBalance, 60n);
  assert.equal(cs.settlement.partyABalance + cs.settlement.partyBBalance, 200n);
  const msg = serializeSettlement(cs.settlement);
  assert.ok(verify(cs.sigA, msg, t.partyA.publicKey));
  assert.ok(verify(cs.sigB, msg, t.partyB.publicKey));
});
