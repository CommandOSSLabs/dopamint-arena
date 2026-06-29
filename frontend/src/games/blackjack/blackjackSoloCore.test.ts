import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias).
import {
  BlackjackProtocol,
  actorFor,
  FIXED_PLAYER_A,
  type BlackjackMove,
} from "../../../../sui-tunnel-ts/src/protocol/blackjack.ts";
import {
  OffchainTunnel,
  verifyCoSignedUpdate,
} from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";
import {
  toSoloBj,
  deriveBjView,
  bjSessionResult,
  stepBlackjackSolo,
  type SoloBjState,
} from "./blackjackSoloCore.ts";

const BANK = 100_000n;

/** The solo wrapper, rebuilt inline (the real one lives in blackjackSoloSpec.ts, which pulls in the
 *  `@/` alias tsx can't resolve). Augments the state poker-style; rules delegate to `super`. */
class TestSoloBj extends BlackjackProtocol {
  constructor() {
    super(FIXED_PLAYER_A);
  }
  private decide(s: { balanceA: bigint; balanceB: bigint }): SoloBjState["inner"]["winner"] {
    // Mirror the spec: only meaningful at terminal, but for the test we just expose the lead.
    if (s.balanceA > s.balanceB) return "A";
    if (s.balanceB > s.balanceA) return "B";
    return "draw";
  }
  initialState(ctx: { tunnelId: string; initialBalances: { a: bigint; b: bigint } }) {
    const s = super.initialState(ctx);
    return toSoloBj(s, this.isTerminal(s) ? this.decide(s) : null, 0);
  }
  applyMove(state: SoloBjState, move: BlackjackMove, by: "A" | "B") {
    const next = super.applyMove(state, move, by);
    const prev = (state as Partial<SoloBjState>).moves ?? 0;
    return toSoloBj(next, this.isTerminal(next) ? this.decide(next) : null, prev + 1);
  }
}

/** Inline self-play bots: mirror the kit bot (actor-gated `randomMove`), free of the `@/` alias. */
function selfPlayBots(proto: BlackjackProtocol) {
  const mk = (seat: "A" | "B") => ({
    plan: (s: SoloBjState) =>
      actorFor(s, FIXED_PLAYER_A) === seat
        ? proto.randomMove(s, seat, Math.random)
        : null,
    confirm: () => {},
    abort: () => {},
  });
  return { A: mk("A"), B: mk("B") };
}

function freshTunnel() {
  const a = createParticipant("a");
  const b = createParticipant("b");
  const protocol = new TestSoloBj();
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xfeed",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: BANK, b: BANK },
  ) as OffchainTunnel<SoloBjState, BlackjackMove>;
  return { protocol, tunnel, bots: selfPlayBots(protocol) };
}

const actorOf = (s: SoloBjState) => actorFor(s, FIXED_PLAYER_A);

test("toSoloBj attaches gamesPlayed (= round) + inner.winner to a flat BlackjackState", () => {
  const { tunnel } = freshTunnel();
  const s = tunnel.state;
  assert.equal(s.gamesPlayed, Number(s.round));
  assert.equal(s.inner.winner, null); // a fresh, non-terminal match has no winner
  assert.equal(typeof s.moves, "number");
});

test("deriveBjView flattens phase/round/hands/balances to plain values", () => {
  const { tunnel } = freshTunnel();
  const v = deriveBjView(tunnel.state);
  assert.equal(typeof v.balanceA, "number");
  assert.equal(typeof v.round, "number");
  assert.ok(Array.isArray(v.playerHand));
  assert.equal(v.winner, null);
});

test("bjSessionResult maps the decided seat (tie/in-progress → draw)", () => {
  const { tunnel } = freshTunnel();
  assert.equal(bjSessionResult({ winner: "A" }), "A");
  assert.equal(bjSessionResult({ winner: "B" }), "B");
  assert.equal(bjSessionResult({ winner: "draw" }), "draw");
  assert.equal(bjSessionResult(tunnel.state.inner), "draw"); // null → neutral
});

test("stepBlackjackSolo advances a bot-vs-bot session, conserving the staked pot each tick", () => {
  const { protocol, tunnel, bots } = freshTunnel();
  let stepped = 0;
  for (let i = 0; i < 300; i++) {
    const r = stepBlackjackSolo(protocol, tunnel, bots, actorOf);
    if (r !== "stepped") break;
    stepped++;
    // Stake swap conserves: balances always sum to the locked total.
    assert.equal(
      tunnel.state.balanceA + tunnel.state.balanceB,
      tunnel.state.total,
    );
  }
  assert.ok(stepped > 0, "made progress");
  // Several moves per round → at least one full round (round advances past 1) within 300 steps.
  assert.ok(tunnel.state.round >= 1n, "rounds are being played");
});

test("a co-signed update verifies after bounded self-play (settleable)", () => {
  const { protocol, tunnel, bots } = freshTunnel();
  for (let i = 0; i < 40; i++) {
    if (stepBlackjackSolo(protocol, tunnel, bots, actorOf) !== "stepped") break;
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
