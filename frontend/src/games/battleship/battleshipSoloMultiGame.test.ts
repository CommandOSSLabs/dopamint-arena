import { test } from "node:test";
import assert from "node:assert/strict";
// Relative .ts paths (tsx ignores the vite alias). This rebuilds the spec's multi-game self-play
// mechanics (fleet regen + the between-game advance commit) inline to verify they actually advance
// through many games on one tunnel and stay settleable — the part that's easy to get wrong.
import {
  MultiGameBattleshipProtocol,
  type MultiGameBattleshipState,
  type MultiGameBattleshipMove,
} from "./protocol/multiGameBattleship.ts";
import {
  makeFleetSecret,
  randomFleetSecret,
  nextMove,
  type FleetSecret,
} from "./engine/selfPlay.ts";
import { placeFleetRandom, placementsToBoard } from "./engine/fleet.ts";
import { randomSalts } from "./engine/merkle.ts";
import { DEFAULT_BOT_DIFFICULTY } from "./engine/bot.ts";
import {
  OffchainTunnel,
  verifyCoSignedUpdate,
} from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";

const BANK = 100n;
const STAKE = 1n;

interface FleetHolder {
  secrets: { A: FleetSecret; B: FleetSecret };
  regenerate(): void;
}
function makeFleetHolder(): FleetHolder {
  const make = () => ({
    A: makeFleetSecret(
      placementsToBoard(placeFleetRandom(Math.random)),
      randomSalts(),
    ),
    B: randomFleetSecret(Math.random),
  });
  const holder = { secrets: make() } as FleetHolder;
  holder.regenerate = () => {
    holder.secrets = make();
  };
  return holder;
}

/** The spec's `stepWith`, inline (raw NUMERIC protocol — no winner wrapper). */
function step(
  proto: MultiGameBattleshipProtocol,
  tunnel: OffchainTunnel<MultiGameBattleshipState, MultiGameBattleshipMove>,
  fleets: FleetHolder,
  maxGames: number,
): "stepped" | "session-over" {
  const state = tunnel.state;
  if (state.inner.winner !== 0) {
    if (state.gamesPlayed + 1 >= maxGames || proto.isTerminal(state)) {
      return "session-over";
    }
    fleets.regenerate();
    tunnel.step(
      { type: "commit", root: fleets.secrets.A.commitment.root },
      "A",
    );
    return "stepped";
  }
  const driven = nextMove(
    state.inner,
    fleets.secrets,
    Math.random,
    DEFAULT_BOT_DIFFICULTY,
  );
  if (!driven) return "session-over";
  tunnel.step(driven.move, driven.by);
  return "stepped";
}

function freshTunnel() {
  const a = createParticipant("a");
  const b = createParticipant("b");
  const proto = new MultiGameBattleshipProtocol(STAKE);
  const tunnel = OffchainTunnel.selfPlay(
    proto,
    "0xb5",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: BANK, b: BANK },
  ) as OffchainTunnel<MultiGameBattleshipState, MultiGameBattleshipMove>;
  return { proto, tunnel, fleets: makeFleetHolder() };
}

test("battleship self-play advances through MULTIPLE games on one tunnel", () => {
  const { proto, tunnel, fleets } = freshTunnel();
  const MAX = 5;
  let outcome: "stepped" | "session-over" = "stepped";
  for (let i = 0; i < 50_000 && outcome === "stepped"; i++) {
    outcome = step(proto, tunnel, fleets, MAX);
  }
  // The whole point of maxGames>1: more than one game plays before the session ends (the old
  // maxGames=1 settled after one). With STAKE=1 and a 100-bank, the cap (not busting) ends it.
  assert.equal(outcome, "session-over");
  assert.ok(
    tunnel.state.gamesPlayed >= 2,
    `expected ≥2 games, got ${tunnel.state.gamesPlayed}`,
  );
  // Balances stay conserved + non-negative across the rematches (no u64 underflow).
  const { a, b } = proto.balances(tunnel.state);
  assert.equal(a + b, 2n * BANK);
  assert.ok(a >= 0n && b >= 0n);
});

test("a co-signed battleship update verifies after multi-game self-play (settleable)", () => {
  const { proto, tunnel, fleets } = freshTunnel();
  for (let i = 0; i < 2_000; i++) {
    if (step(proto, tunnel, fleets, 3) === "session-over") break;
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
