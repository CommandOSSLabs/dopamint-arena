import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK / game-package imports use RELATIVE .ts paths (mirrors tttSoloCore.test.ts).
import {
  MultiGameCaroProtocol,
  type MultiGameCaroMove,
  type CaroState,
} from "./packages/shared/src/caro/protocol.ts";
import { pickCaroMove } from "./packages/shared/src/caro/bot.ts";
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
  deriveCaroView,
  caroSessionResult,
  stepMultiGameCaro,
  kickoffNextGameCaro,
  type SoloCaroState,
  type CaroBot,
} from "./caroSoloCore.ts";

const BANK = 100n;
// Small board so a bot-vs-bot game decides (win or full-board draw) well inside the step budget.
const BOARD = 5;

/** The solo wrapper, rebuilt inline (the real one lives in caroSoloSpec.ts, which pulls in the `@/`
 *  alias). Converts inner.winner at the boundary; rules delegate to the numeric protocol. */
class TestSoloCaro {
  readonly name = "caro.series.v2";
  private mg: MultiGameCaroProtocol;
  constructor(maxGames: number, boardSize: number, stake: bigint) {
    this.mg = new MultiGameCaroProtocol(maxGames, boardSize, stake);
  }
  initialState(ctx: {
    tunnelId: string;
    initialBalances: { a: bigint; b: bigint };
  }) {
    return toSolo(this.mg.initialState(ctx));
  }
  applyMove(s: SoloCaroState, m: MultiGameCaroMove, by: "A" | "B") {
    return toSolo(this.mg.applyMove(toRaw(s), m, by));
  }
  encodeState(s: SoloCaroState) {
    return this.mg.encodeState(toRaw(s));
  }
  balances(s: SoloCaroState) {
    return this.mg.balances(toRaw(s));
  }
  isTerminal(s: SoloCaroState) {
    return this.mg.isTerminal(toRaw(s));
  }
}

/** Inline strong-vs-strong bots — the same `pickCaroMove` the spec injects, reading the NUMERIC
 *  inner state the stepper hands them via `toRaw`. */
const bots: Record<"A" | "B", CaroBot> = {
  A: (inner: CaroState, rng) => pickCaroMove(inner, "A", rng, "strong"),
  B: (inner: CaroState, rng) => pickCaroMove(inner, "B", rng, "strong"),
};

function freshTunnel() {
  const a = createParticipant("a");
  const b = createParticipant("b");
  const protocol = new TestSoloCaro(1000, BOARD, 0n); // money-neutral, like the real caro game
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xca40",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: BANK, b: BANK },
  ) as OffchainTunnel<SoloCaroState, MultiGameCaroMove>;
  return { protocol, tunnel };
}

test("winner bijection: A, B, draw, none ↔ null roundtrips", () => {
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
  const mg = new MultiGameCaroProtocol(3, BOARD, 0n);
  const raw = mg.initialState({
    tunnelId: "x",
    initialBalances: { a: BANK, b: BANK },
  });
  assert.deepEqual(toRaw(toSolo(raw)), raw);
  assert.equal(toSolo(raw).inner.winner, null); // fresh board: no winner
});

test("deriveCaroView flattens board/size/winner/balances to plain values", () => {
  const { tunnel } = freshTunnel();
  const v = deriveCaroView(tunnel.state);
  assert.equal(v.board.length, BOARD * BOARD);
  assert.equal(v.size, BOARD);
  assert.equal(v.winner, null);
  assert.equal(typeof v.balanceA, "number");
  assert.equal(v.balanceA, Number(BANK));
});

test("caroSessionResult maps the decided seat (draw/in-progress → draw)", () => {
  const { tunnel } = freshTunnel();
  const inner = tunnel.state.inner;
  assert.equal(caroSessionResult({ ...inner, winner: "A" }), "A");
  assert.equal(caroSessionResult({ ...inner, winner: "B" }), "B");
  assert.equal(caroSessionResult({ ...inner, winner: "draw" }), "draw");
  assert.equal(caroSessionResult(inner), "draw"); // null in-progress → neutral
});

test("stepMultiGameCaro advances a bot-vs-bot duel to a decision, conserving the pot", () => {
  const { protocol, tunnel } = freshTunnel();
  let stepped = 0;
  let sawGameOver = false;
  for (let i = 0; i < 400; i++) {
    const r = stepMultiGameCaro(protocol, tunnel, bots);
    if (r === "stepped") {
      stepped++;
      // Money-neutral (stake 0): balances are conserved and sum to the locked total every tick.
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
  // A 5×5 board fills in ≤25 plies, so an inner game must decide (win or draw) inside the window.
  assert.ok(sawGameOver, "an inner game ended (game-over) within the window");
});

test("kickoffNextGameCaro rematches onto the next game on the same tunnel", () => {
  const { protocol, tunnel } = freshTunnel();
  let outcome = "stepped";
  for (let i = 0; i < 400 && outcome === "stepped"; i++) {
    outcome = stepMultiGameCaro(protocol, tunnel, bots);
  }
  if (outcome === "game-over") {
    assert.equal(tunnel.state.gamesPlayed, 0, "still game 1 at the boundary");
    kickoffNextGameCaro(tunnel);
    assert.equal(tunnel.state.gamesPlayed, 1, "rematched onto game 2");
    assert.equal(tunnel.state.inner.winner, null, "fresh game has no winner");
  }
});

test("a co-signed caro update verifies after bounded self-play (settleable)", () => {
  const { protocol, tunnel } = freshTunnel();
  for (let i = 0; i < 20; i++) {
    if (stepMultiGameCaro(protocol, tunnel, bots) === "session-over") break;
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
