import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK / game-package imports use RELATIVE .ts paths (tsx ignores the vite alias).
import {
  MultiGameTicTacToeProtocol,
  type MultiGameTicTacToeState,
  type MultiGameTicTacToeMove,
} from "./packages/shared/src/ttt/multiGameProtocol.ts";
import {
  OffchainTunnel,
  verifyCoSignedUpdate,
} from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";
import {
  numToWinner,
  winnerToNum,
  toSolo,
  toRaw,
  deriveTttView,
  tttSessionResult,
  stepMultiGameTtt,
  kickoffNextGameTtt,
  type SoloTttState,
} from "./tttSoloCore.ts";

const BANK = 100n;
const STAKE = 1n;

/** The solo wrapper, rebuilt inline (the real one lives in tttSoloSpec.ts, which pulls in the `@/`
 *  alias tsx can't resolve). Converts inner.winner at the boundary; rules delegate to numeric. */
class TestSoloTtt {
  readonly name = "tic_tac_toe.multi.v1";
  private mg: MultiGameTicTacToeProtocol;
  constructor(maxGames: number, stake: bigint) {
    this.mg = new MultiGameTicTacToeProtocol(maxGames, stake);
  }
  initialState(ctx: { tunnelId: string; initialBalances: { a: bigint; b: bigint } }) {
    return toSolo(this.mg.initialState(ctx));
  }
  applyMove(s: SoloTttState, m: MultiGameTicTacToeMove, by: "A" | "B") {
    return toSolo(this.mg.applyMove(toRaw(s), m, by));
  }
  encodeState(s: SoloTttState) {
    return this.mg.encodeState(toRaw(s));
  }
  balances(s: SoloTttState) {
    return this.mg.balances(toRaw(s));
  }
  isTerminal(s: SoloTttState) {
    return this.mg.isTerminal(toRaw(s));
  }
}

/** Inline self-play bots: the same random-move source the kit bot uses, but free of the `@/` alias.
 *  Reads the NUMERIC multi-game state (what the stepper hands them via toRaw). */
function selfPlayBots(mg: MultiGameTicTacToeProtocol) {
  const mk = (seat: "A" | "B") => ({
    plan: (s: MultiGameTicTacToeState) => mg.randomMove(s, seat, Math.random),
    confirm: () => {},
    abort: () => {},
  });
  return { A: mk("A"), B: mk("B") };
}

function freshTunnel() {
  const a = createParticipant("a");
  const b = createParticipant("b");
  const protocol = new TestSoloTtt(1000, STAKE);
  const mg = new MultiGameTicTacToeProtocol(1000, STAKE);
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xfeed",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: BANK, b: BANK },
  ) as OffchainTunnel<SoloTttState, MultiGameTicTacToeMove>;
  return { protocol, tunnel, bots: selfPlayBots(mg) };
}

test("winner bijection: X≙A, O≙B, draw, none↔null roundtrips", () => {
  for (const [n, s] of [
    [0, null],
    [1, "A"],
    [2, "B"],
    [3, "draw"],
  ] as const) {
    assert.equal(numToWinner(n), s);
    assert.equal(winnerToNum(s), n);
  }
});

test("toSolo/toRaw roundtrip preserves the numeric protocol state", () => {
  const mg = new MultiGameTicTacToeProtocol(3, STAKE);
  const raw = mg.initialState({
    tunnelId: "x",
    initialBalances: { a: BANK, b: BANK },
  });
  const back = toRaw(toSolo(raw));
  assert.deepEqual(back, raw);
  assert.equal(toSolo(raw).inner.winner, null); // fresh board: no winner
});

test("deriveTttView flattens board/turn/winner/balances to plain values", () => {
  const { tunnel } = freshTunnel();
  const v = deriveTttView(tunnel.state);
  assert.equal(v.board.length, 9);
  assert.equal(v.winner, null);
  assert.equal(typeof v.balanceA, "number");
  assert.equal(v.balanceA, Number(BANK));
});

test("tttSessionResult maps the decided seat (draw/in-progress → draw)", () => {
  const { tunnel } = freshTunnel();
  const inner = tunnel.state.inner;
  assert.equal(tttSessionResult({ ...inner, winner: "A" }), "A");
  assert.equal(tttSessionResult({ ...inner, winner: "B" }), "B");
  assert.equal(tttSessionResult({ ...inner, winner: "draw" }), "draw");
  assert.equal(tttSessionResult(inner), "draw"); // null in-progress → neutral
});

test("stepMultiGameTtt advances a bot-vs-bot duel, conserving the staked pot each tick", () => {
  const { protocol, tunnel, bots } = freshTunnel();
  let stepped = 0;
  let sawGameOver = false;
  for (let i = 0; i < 400; i++) {
    const r = stepMultiGameTtt(protocol, tunnel, bots);
    if (r === "stepped") {
      stepped++;
      // Stake swap conserves: carried balances always sum to the locked total.
      assert.equal(
        tunnel.state.inner.balanceA + tunnel.state.inner.balanceB,
        2n * BANK,
      );
    } else if (r === "game-over") {
      sawGameOver = true;
      break;
    } else break; // session-over
  }
  assert.ok(stepped > 0, "made progress");
  // A 3x3 board decides within 9 plies, so a game-over must appear inside 400 steps.
  assert.ok(sawGameOver, "an inner game ended (game-over) within the window");
});

test("kickoffNextGameTtt advances onto the next game on the same tunnel", () => {
  const { protocol, tunnel, bots } = freshTunnel();
  let outcome = "stepped";
  for (let i = 0; i < 400 && outcome === "stepped"; i++) {
    outcome = stepMultiGameTtt(protocol, tunnel, bots);
  }
  if (outcome === "game-over") {
    assert.equal(tunnel.state.gamesPlayed, 0, "still game 1 at the boundary");
    kickoffNextGameTtt(tunnel);
    assert.equal(tunnel.state.gamesPlayed, 1, "rematched onto game 2");
    assert.equal(tunnel.state.inner.winner, null, "fresh game has no winner");
  }
});

test("a co-signed update verifies after bounded self-play (settleable)", () => {
  const { protocol, tunnel, bots } = freshTunnel();
  for (let i = 0; i < 20; i++) {
    if (stepMultiGameTtt(protocol, tunnel, bots) === "session-over") break;
  }
  const u = tunnel.latest;
  assert.ok(u, "has a co-signed update");
  assert.ok(
    verifyCoSignedUpdate(
      u!,
      { publicKey: tunnel.partyA.publicKey, scheme: tunnel.partyA.scheme },
      { publicKey: tunnel.partyB.publicKey, scheme: tunnel.partyB.scheme },
    ),
    "settleable co-signed state",
  );
});
