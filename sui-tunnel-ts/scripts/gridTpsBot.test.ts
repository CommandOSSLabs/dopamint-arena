/**
 * Behaviour tests for the grid TPS bot's play logic. Run:
 *   node --import tsx --test scripts/gridTpsBot.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { core, proof } from "../src/index.ts";
import { CaroProtocol, caroNextMover, caroCandidateCells } from "../src/protocol/caro.ts";
import { pickCell, playBoundedMatches, parseAllTunnelIds } from "./gridTpsBot.ts";

const MODES = ["uniform", "center", "adjacent", "smart"] as const;

function freshTunnel(proto: CaroProtocol, stake: bigint) {
  const a = core.generateKeyPair();
  const b = core.generateKeyPair();
  return core.OffchainTunnel.selfPlay(proto, "0x7", a, b, "0xa", "0xb", { a: stake, b: stake });
}

const rng = (() => {
  let s = 99;
  return () => ((s = (s * 1103515245 + 12345) >>> 0) / 0x100000000);
})();

test("every mode returns a legal empty cell (playing and over phases)", () => {
  const proto = new CaroProtocol({ boardSize: 7, winLength: 4, matchCap: 3, stake: 50n });
  let s = proto.initialState({ tunnelId: "0x1", initialBalances: { a: 10_000n, b: 10_000n } });
  // make a few moves so the board has marks (so adjacent/smart have neighbours to use)
  for (let i = 0; i < 4; i++) {
    const by = caroNextMover(s);
    s = proto.applyMove(s, proto.randomMove(s, by, rng)!, by);
  }
  for (const mode of MODES) {
    const by = caroNextMover(s);
    const cell = pickCell(mode, s, by, proto.boardSize, proto.winLength, rng);
    const cands = caroCandidateCells(s, proto.boardSize);
    assert.ok(cands.includes(cell), `${mode} returned non-candidate cell ${cell}`);
    assert.equal(s.board[cell], 0, `${mode} chose an occupied cell`);
  }
});

test("playBoundedMatches plays exactly matchCap matches for ttt (3x3)", () => {
  const proto = new CaroProtocol({ boardSize: 3, winLength: 3, matchCap: 8, stake: 100n });
  const tunnel = freshTunnel(proto, 100n * 9n);
  const transcript = new proof.Transcript("0x7");
  tunnel.onUpdate = (u) => transcript.append(u);
  const r = playBoundedMatches(tunnel, proto, [...MODES], 0n, rng);
  assert.equal(r.matches, 8, "played all matches");
  assert.ok(r.updates >= 8, "each match is at least one update");
  assert.equal(transcript.length, r.updates, "every update anchored");
  assert.equal(proto.isTerminal(tunnel.state), true);
  assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, 100n * 9n * 2n, "balances conserve");
});

test("playBoundedMatches plays exactly matchCap matches for caro (9x9, 5)", () => {
  const proto = new CaroProtocol({ boardSize: 9, winLength: 5, matchCap: 4, stake: 50n });
  const tunnel = freshTunnel(proto, 50n * 6n);
  const r = playBoundedMatches(tunnel, proto, ["uniform"], 0n, rng);
  assert.equal(r.matches, 4);
  // a 9x9 game runs many moves, so a 4-match run anchors a healthy pile of updates
  assert.ok(r.updates > 20, `expected many updates, got ${r.updates}`);
});

test("parseAllTunnelIds collects every created Tunnel object", () => {
  const changes = [
    { type: "created", objectType: "0xp::tunnel::Tunnel<0x2::sui::SUI>", objectId: "0x1" },
    { type: "created", objectType: "0xp::tunnel::Tunnel<0x2::sui::SUI>", objectId: "0x2" },
    { type: "mutated", objectType: "0x2::coin::Coin", objectId: "0x9" },
  ];
  assert.deepEqual(parseAllTunnelIds(changes), ["0x1", "0x2"]);
  assert.deepEqual(parseAllTunnelIds(undefined), []);
});
