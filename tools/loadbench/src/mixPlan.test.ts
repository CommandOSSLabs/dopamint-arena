import { test, expect } from "bun:test";
import {
  planMix,
  GAMES,
  mpsOf,
  SATURATION_KNEE,
  MAX_AFFORDABLE_TUNNELS,
  B_OPEN,
  B_CLOSE,
  NODE_PTB_S,
  AWS_SCALE,
} from "./mixPlan";

test("carrier tunnels = target·share/mps, boxes = TPS/box-rate, never rotates", () => {
  const p = planMix(1_000_000, { "chat.v1": 1 }, { scale: 1 });
  const chat = p.rows[0];
  expect(chat.tunnels).toBe(Math.ceil(1_000_000 / mpsOf("chat.v1")));
  expect(chat.boxes).toBeCloseTo(1_000_000 / GAMES["chat.v1"].moveTpsBox, 5);
  expect(chat.maxChurnPerSec).toBe(0); // m = ∞ carrier never rotates
});

test("mps defaults to the box-saturation knee → minimal tunnels ≈ knee × boxes", () => {
  const p = planMix(1_000_000, { "chat.v1": 1 }, { scale: 1 });
  expect(mpsOf("chat.v1")).toBeCloseTo(GAMES["chat.v1"].moveTpsBox / SATURATION_KNEE, 5);
  // tunnels ≈ KNEE × boxes (the minimal-tunnel relationship; ±per-game ceil rounding)
  expect(p.totalTunnels / (SATURATION_KNEE * p.totalBoxes)).toBeCloseTo(1, 2);
});

test("ramp/drain use the batched node ceiling (N / (node · B))", () => {
  const p = planMix(1_000_000, { "chat.v1": 1 }, { scale: 1 });
  expect(p.rampS).toBeCloseTo(p.totalTunnels / (NODE_PTB_S * B_OPEN), 6);
  expect(p.drainS).toBeCloseTo(p.totalTunnels / (NODE_PTB_S * B_CLOSE), 6);
});

test("variety settles once by default: matchLifeS = m/mps, no mid-peak churn, tx = 2N", () => {
  const p = planMix(100_000, { "blackjack.bet.v1": 1 }, { scale: 1, durationS: 60 });
  const r = p.rows[0];
  const g = GAMES["blackjack.bet.v1"];
  expect(r.matchLifeS).toBeCloseTo(g.m / mpsOf("blackjack.bet.v1"), 6);
  // maxChurnPerSec is the rotation CEILING (info); the default incurs NONE of it.
  expect(r.maxChurnPerSec).toBeCloseTo(r.tunnels / r.matchLifeS, 6);
  expect(p.liveSettlesPerSec).toBe(0);
  expect(p.totalOpens).toBe(p.totalTunnels);
  expect(p.totalCloses).toBe(p.totalTunnels);
});

test("scale divides box count (AWS scaling)", () => {
  const m4 = planMix(1_000_000, { "chat.v1": 1 }, { scale: 1 });
  const aws = planMix(1_000_000, { "chat.v1": 1 }, { scale: AWS_SCALE });
  expect(aws.totalBoxes).toBeCloseTo(m4.totalBoxes / AWS_SCALE, 6);
});

test("mix shares must sum to 1", () => {
  expect(() => planMix(1e6, { "chat.v1": 0.5 })).toThrow("sum to 1");
});

test("carrier-only run has no rotations → opens = closes = N", () => {
  const p = planMix(1_000_000, { "chat.v1": 1 }, { scale: 1, durationS: 60 });
  expect(p.totalOpens).toBe(p.totalTunnels);
  expect(p.totalCloses).toBe(p.totalTunnels);
});

test("opt-in live-settles trickle adds rotations to the tx bill, clamped to the ceiling", () => {
  const p = planMix(100_000, { "blackjack.bet.v1": 1 }, { durationS: 60, liveSettlesPerSec: 50 });
  expect(p.liveSettlesPerSec).toBe(50);
  expect(p.totalOpens).toBeCloseTo(p.totalTunnels + 50 * 60, 3);
  expect(p.churnPtbPerSec).toBeCloseTo(50 * (1 / B_OPEN + 1 / B_CLOSE), 9);
  // asking for more than the variety pool can sustain clamps to maxChurnPerSec
  const clamped = planMix(100_000, { "blackjack.bet.v1": 1 }, { liveSettlesPerSec: 1e12 });
  expect(clamped.liveSettlesPerSec).toBeCloseTo(clamped.maxChurnPerSec, 3);
});

test("affordability flag trips when concurrent tunnels exceed the cap", () => {
  expect(planMix(1_000_000, { "chat.v1": 1 }).affordable).toBe(true);
  const big = planMix(200_000_000, { "chat.v1": 1 });
  expect(big.totalTunnels).toBeGreaterThan(MAX_AFFORDABLE_TUNNELS);
  expect(big.affordable).toBe(false);
});
