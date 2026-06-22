// frontend/src/games/quantumPoker/pokerSelfPlay.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { keyPairFromRng } from "sui-tunnel-ts/core/crypto";
import { ed25519Address } from "sui-tunnel-ts/core/crypto";
import { QuantumPokerProtocol } from "sui-tunnel-ts/protocol/quantumPoker";
import type { BotContext } from "@/agent/gameKit";
import {
  makeSeatBot,
  stepPokerAuto,
  runPokerSelfPlayToEnd,
  legalPokerActions,
} from "./pokerSelfPlay";

function mulberry32(seed: number) {
  let v = seed;
  return () => {
    v |= 0;
    v = (v + 0x6d2b79f5) | 0;
    let t = Math.imul(v ^ (v >>> 15), 1 | v);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAKE = 10_000n;
const HAND_CAP = 3n; // small cap → terminal fast in tests

function newTunnel() {
  const keyRng = mulberry32(99);
  const a = keyPairFromRng(keyRng);
  const b = keyPairFromRng(keyRng);
  const protocol = new QuantumPokerProtocol(HAND_CAP);
  return OffchainTunnel.selfPlay(
    protocol,
    "0x" + "51".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: STAKE, b: STAKE },
  );
}

test("two personas self-play a full poker tunnel to done, balance conserved", () => {
  const tunnel = newTunnel();
  const ctx: BotContext = { rngForSeat: (s) => mulberry32(s === "A" ? 1 : 2) };
  const botA = makeSeatBot("A", STAKE, HAND_CAP, { name: "Nari", persona: "tight" }, ctx);
  const botB = makeSeatBot("B", STAKE, HAND_CAP, { name: "Jules", persona: "loose" }, ctx);

  const steps = runPokerSelfPlayToEnd(tunnel, botA, botB, 5000);

  assert.equal(tunnel.state.phase, "done");
  assert.ok(steps > 0 && steps < 5000);
  assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, STAKE * 2n);
});

test("stepPokerAuto returns null at terminal", () => {
  const tunnel = newTunnel();
  const ctx: BotContext = { rngForSeat: (s) => mulberry32(s === "A" ? 1 : 2) };
  const botA = makeSeatBot("A", STAKE, HAND_CAP, { name: "Nari", persona: "tight" }, ctx);
  const botB = makeSeatBot("B", STAKE, HAND_CAP, { name: "Jules", persona: "loose" }, ctx);
  runPokerSelfPlayToEnd(tunnel, botA, botB, 5000);
  assert.equal(stepPokerAuto(tunnel, botA, botB, 1n), null);
});

test("legalPokerActions allows check when nobody has bet this street", () => {
  const tunnel = newTunnel();
  const ctx: BotContext = { rngForSeat: (s) => mulberry32(s === "A" ? 1 : 2) };
  const botA = makeSeatBot("A", STAKE, HAND_CAP, { name: "Nari", persona: "tight" }, ctx);
  const botB = makeSeatBot("B", STAKE, HAND_CAP, { name: "Jules", persona: "loose" }, ctx);
  // Advance until a betting phase with equal street bets is reached.
  let ts = 1n;
  for (let i = 0; i < 200; i++) {
    const s = tunnel.state;
    if (
      (s.phase === "preflop_bet" || s.phase === "flop_bet") &&
      s.streetBetA === s.streetBetB
    ) {
      const acts = legalPokerActions(s, s.toAct);
      assert.equal(acts.canCheck, true);
      assert.equal(acts.callAmount, 0n);
      return;
    }
    if (!stepPokerAuto(tunnel, botA, botB, ts++)) break;
  }
  assert.fail("never reached an unbet betting street");
});
