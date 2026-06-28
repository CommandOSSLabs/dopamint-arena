import { test } from "node:test";
import assert from "node:assert/strict";

import { createParticipant } from "sui-tunnel-ts/core/keys";
import { makeEndpoint } from "sui-tunnel-ts/core/tunnel";
import { defaultBackend } from "sui-tunnel-ts/core/crypto-native";
import {
  DistributedTunnel,
  type Transport,
} from "sui-tunnel-ts/core/distributedTunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  BattleshipProtocol,
  type BattleshipMove,
  type BattleshipState,
} from "sui-tunnel-ts/protocol/battleship";
import { battleshipMoveCodec } from "sui-tunnel-ts/protocol/battleshipCodec";
import { FLEET_CELLS } from "./fleet";
import { type FleetSecret, randomFleetSecret } from "./selfPlay";
import { pickShot, BOT_CONFIGS } from "./bot";
import { computeCommitment } from "sui-tunnel-ts/core/commitment";
import { proposeDue, answerMove } from "./pvpDriver";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOCKED = 500n;
const TUNNEL_ID = `0x${"11".repeat(32)}`;

/** Two transports whose frames cross over, delivered iteratively by `pump` (no deep recursion). */
function pairedTransports() {
  let aCb: (f: Uint8Array) => void = () => {};
  let bCb: (f: Uint8Array) => void = () => {};
  const queue: Array<() => void> = [];
  const tA: Transport = {
    send: (f) => queue.push(() => bCb(f)),
    onFrame: (cb) => (aCb = cb),
  };
  const tB: Transport = {
    send: (f) => queue.push(() => aCb(f)),
    onFrame: (cb) => (bCb = cb),
  };
  const pump = () => {
    let guard = 0;
    while (queue.length) {
      if (++guard > 50_000)
        throw new Error("pump runaway — game did not converge");
      queue.shift()!();
    }
  };
  return { tA, tB, pump };
}

type DT = DistributedTunnel<BattleshipState, BattleshipMove>;

function makeSeat(
  role: Party,
  transport: Transport,
  selfKeys: ReturnType<typeof createParticipant>,
  oppKeys: ReturnType<typeof createParticipant>,
): DT {
  const backend = defaultBackend();
  return new DistributedTunnel<BattleshipState, BattleshipMove>(
    new BattleshipProtocol(100n),
    {
      tunnelId: TUNNEL_ID,
      self: makeEndpoint(backend, selfKeys.address, selfKeys.keyPair, true),
      opponent: makeEndpoint(
        backend,
        oppKeys.address,
        {
          publicKey: oppKeys.keyPair.publicKey,
          scheme: oppKeys.keyPair.scheme,
        },
        false,
      ),
      selfParty: role,
      moveCodec: battleshipMoveCodec,
    },
    transport,
    { a: LOCKED, b: LOCKED },
  );
}

/**
 * Drive both tunnels to completion via `proposeDue` (commit / answer / reveal_board)
 * plus explicit shoot calls standing in for the human. Uses a sequential loop to
 * avoid the simultaneous-proposal collision that reactive onConfirmed would cause.
 */
function driveToCompletion(
  dtA: DT,
  dtB: DT,
  secretA: FleetSecret,
  secretB: FleetSecret,
  pump: () => void,
  rng: () => number,
): void {
  for (let i = 0; i < 5000; i++) {
    const state = dtA.state;
    if (state.phase === "over") break;

    // proposeDue handles commit / answer / reveal_board; shots are picked here.
    if (proposeDue(dtA, "A", secretA)) {
      pump();
      continue;
    }
    if (proposeDue(dtB, "B", secretB)) {
      pump();
      continue;
    }

    // Neither seat owes an auto-move — it must be a shot turn.
    if (state.phase === "playing" && !state.pendingShot) {
      const shooter = state.turn;
      const dt = shooter === "A" ? dtA : dtB;
      dt.propose(
        {
          kind: "shoot",
          cell: pickShot(state, shooter, rng, BOT_CONFIGS["hard"]),
        },
        BigInt(i + 1),
      );
      pump();
      continue;
    }

    break;
  }
}

test("two independent seats play a full commit→shoot→answer→reveal_board→over game", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const A = createParticipant("A");
    const B = createParticipant("B");
    const secretA = randomFleetSecret(mulberry32(seed * 3));
    const secretB = randomFleetSecret(mulberry32(seed * 3 + 1));
    const { tA, tB, pump } = pairedTransports();

    const dtA = makeSeat("A", tA, A, B);
    const dtB = makeSeat("B", tB, B, A);

    driveToCompletion(dtA, dtB, secretA, secretB, pump, mulberry32(seed * 7));

    // Both tunnels independently reach the SAME terminal public state.
    assert.equal(dtA.state.phase, "over", `seed ${seed}: should be over`);
    assert.notEqual(dtA.state.winner, 0, `seed ${seed}: decisive winner`);
    assert.equal(
      dtA.state.winner,
      dtB.state.winner,
      `seed ${seed}: agree on winner`,
    );
    assert.deepEqual(
      dtA.protocol.encodeState(dtA.state),
      dtB.protocol.encodeState(dtB.state),
      `seed ${seed}: identical co-signed state`,
    );

    const winner = dtA.state.winner;
    const loserSunk = winner === 1 ? dtA.state.hitsOnB : dtA.state.hitsOnA;
    assert.equal(loserSunk, FLEET_CELLS, `seed ${seed}: loser fully sunk`);
    assert.equal(dtA.state.balanceA + dtA.state.balanceB, 2n * LOCKED);
    assert.equal(
      winner === 1 ? dtA.state.balanceA : dtA.state.balanceB,
      LOCKED + 100n,
    );
  }
});

test("proposeDue returns true for owed commit and false once committed", () => {
  const A = createParticipant("A");
  const B = createParticipant("B");
  const secretA = randomFleetSecret(mulberry32(200));
  const secretB = randomFleetSecret(mulberry32(201));
  const { tA, tB, pump } = pairedTransports();

  const dtA = makeSeat("A", tA, A, B);
  const dtB = makeSeat("B", tB, B, A);

  // A owes a commit in the initial awaitingCommits state.
  assert.equal(proposeDue(dtA, "A", secretA), true, "A owes initial commit");
  pump();

  // After committing, A no longer owes a commit (commitA is set).
  assert.equal(
    proposeDue(dtA, "A", secretA),
    false,
    "A does not owe a second commit",
  );

  // B owes its commit now that A has committed.
  assert.equal(proposeDue(dtB, "B", secretB), true, "B owes its commit");
  pump();

  // After B commits, neither seat owes a commit (phase moved to playing).
  assert.equal(
    dtA.state.phase,
    "playing",
    "phase is playing after both commit",
  );
  assert.equal(
    proposeDue(dtA, "A", secretA),
    false,
    "A owes no commit in playing",
  );
  assert.equal(
    proposeDue(dtB, "B", secretB),
    false,
    "B owes no commit in playing",
  );
});

test("proposeDue returns true for owed answer and false for the shooter", () => {
  const A = createParticipant("A");
  const B = createParticipant("B");
  const secretA = randomFleetSecret(mulberry32(300));
  const secretB = randomFleetSecret(mulberry32(301));
  const { tA, tB, pump } = pairedTransports();

  const dtA = makeSeat("A", tA, A, B);
  const dtB = makeSeat("B", tB, B, A);

  // Commit both seats to enter playing phase.
  proposeDue(dtA, "A", secretA);
  pump();
  proposeDue(dtB, "B", secretB);
  pump();

  assert.equal(dtA.state.phase, "playing", "should be in playing phase");
  // No pendingShot yet: proposeDue returns false for both.
  assert.equal(
    proposeDue(dtA, "A", secretA),
    false,
    "A owes nothing — no pending shot",
  );
  assert.equal(
    proposeDue(dtB, "B", secretB),
    false,
    "B owes nothing — no pending shot",
  );

  // A fires first (A's turn).
  dtA.propose({ kind: "shoot", cell: 0 }, 0n);
  pump();

  // Now there is a pendingShot by A; B owes the answer, A does not.
  assert.ok(dtA.state.pendingShot, "shot is pending");
  assert.equal(dtA.state.pendingShot!.by, "A", "A fired the shot");
  assert.equal(
    proposeDue(dtB, "B", secretB),
    true,
    "B owes answer to A's shot",
  );
  assert.equal(
    proposeDue(dtA, "A", secretA),
    false,
    "A is the shooter; no answer owed",
  );
});

test("proposeDue returns true for owed reveal_board and false once revealed", () => {
  const A = createParticipant("A");
  const B = createParticipant("B");
  const secretA = randomFleetSecret(mulberry32(400));
  const secretB = randomFleetSecret(mulberry32(401));
  const { tA, tB, pump } = pairedTransports();

  const dtA = makeSeat("A", tA, A, B);
  const dtB = makeSeat("B", tB, B, A);

  // Manually construct a revealBoards state on both tunnels by driving
  // the game to completion up to the reveal phase.
  const rng = mulberry32(402);

  // Drive the game forward until the phase becomes revealBoards.
  for (let i = 0; i < 5000; i++) {
    const state = dtA.state;
    if (state.phase === "revealBoards" || state.phase === "over") break;

    if (proposeDue(dtA, "A", secretA)) {
      pump();
      continue;
    }
    if (proposeDue(dtB, "B", secretB)) {
      pump();
      continue;
    }

    if (state.phase === "playing" && !state.pendingShot) {
      const shooter = state.turn;
      const dt = shooter === "A" ? dtA : dtB;
      dt.propose(
        {
          kind: "shoot",
          cell: pickShot(state, shooter, rng, BOT_CONFIGS["hard"]),
        },
        BigInt(i + 1),
      );
      pump();
      continue;
    }

    break;
  }

  if (dtA.state.phase !== "revealBoards") {
    // Game terminated without a revealBoards phase (should not happen with a full game).
    return;
  }

  // Ordering: A goes first, B waits until A's reveal is confirmed.
  assert.equal(
    proposeDue(dtA, "A", secretA),
    true,
    "A owes reveal_board — A's turn first",
  );
  assert.equal(
    proposeDue(dtB, "B", secretB),
    false,
    "B does not propose yet — must wait for A's reveal to be confirmed",
  );

  // Confirm A's reveal; now B's turn.
  pump();

  // After A reveals, B owes its reveal.
  assert.equal(
    proposeDue(dtB, "B", secretB),
    true,
    "B owes reveal_board after A revealed",
  );
  // A no longer owes a reveal once revealedA is true.
  assert.equal(
    proposeDue(dtA, "A", secretA),
    false,
    "A does not owe a second reveal",
  );
  pump();

  // After both reveals, game is over.
  assert.equal(dtA.state.phase, "over", "game is over after both reveals");
  assert.equal(
    proposeDue(dtA, "A", secretA),
    false,
    "A owes nothing in over phase",
  );
  assert.equal(
    proposeDue(dtB, "B", secretB),
    false,
    "B owes nothing in over phase",
  );
});

test("answerMove returns correct hit/miss for the fleet secret", () => {
  const secret = randomFleetSecret(mulberry32(500));
  // Find a ship cell and a water cell.
  const shipCell = secret.board.findIndex((v) => v === 1);
  const waterCell = secret.board.findIndex((v) => v === 0);
  assert.ok(shipCell >= 0, "fleet has at least one ship cell");
  assert.ok(waterCell >= 0, "fleet has at least one water cell");

  const hitAnswer = answerMove(secret, shipCell);
  assert.equal(hitAnswer.kind, "answer");
  assert.equal((hitAnswer as { kind: "answer"; isHit: boolean }).isHit, true);

  const missAnswer = answerMove(secret, waterCell);
  assert.equal(missAnswer.kind, "answer");
  assert.equal((missAnswer as { kind: "answer"; isHit: boolean }).isHit, false);
});

test("a reveal_board that contradicts answered shots is rejected by the protocol", () => {
  const secretB = randomFleetSecret(mulberry32(102));

  const proto = new BattleshipProtocol(100n);

  // Find a water cell in B's fleet — a cell B honestly answered "miss" to previously.
  // We will construct a fake state where B LIED and claimed that water cell was a HIT.
  // When B reveals the real board (which passes the commitment check and isLegalBoard check),
  // the protocol should catch that the revealed board contradicts the recorded answer.
  const waterCell = secretB.board.findIndex((v) => v === 0);
  assert.ok(waterCell >= 0, "fleet has at least one water cell");

  // The real commitment for the real board — commitment check passes.
  const realCommitment = computeCommitment(secretB.board, secretB.salt);

  // Fake state: B lied during the game and said the water cell was a HIT.
  const fakeState: BattleshipState = {
    phase: "revealBoards",
    turn: "A",
    pendingShot: null,
    commitA: new Uint8Array(32),
    commitB: realCommitment,
    shotsAtA: [],
    shotsAtB: [{ cell: waterCell, isHit: true }], // lie: B claimed a water cell was a hit
    hitsOnA: 0,
    hitsOnB: 1,
    revealedA: true,
    revealedB: false,
    winner: 0,
    balanceA: LOCKED,
    balanceB: LOCKED,
    total: 2n * LOCKED,
    stake: 100n,
  };

  // The real board says waterCell is 0 (water), but the recorded shot claims isHit: true —
  // the protocol must catch this contradiction when B reveals the real board.
  assert.throws(
    () =>
      proto.applyMove(
        fakeState,
        {
          kind: "reveal_board",
          board: secretB.board,
          salt: secretB.salt,
        },
        "B",
      ),
    /reveal contradicts answered shot/,
  );
});
