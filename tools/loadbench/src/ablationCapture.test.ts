import { test, expect } from "bun:test";
import { captureMatch, medianNs } from "./ablation";
import { decodeFrame } from "../../../sui-tunnel-ts/src/core/distributedFrame";
import { bigintSafeCodec } from "./match";

test("medianNs returns a positive per-call time", () => {
  const ns = medianNs(() => {
    let s = 0;
    for (let i = 0; i < 100; i++) s += i;
    if (s < 0) throw new Error("unreachable");
  }, 1000, 5);
  expect(ns).toBeGreaterThan(0);
});

test("captureMatch harvests real blackjack artifacts deterministically", async () => {
  const a = await captureMatch("blackjack");
  const b = await captureMatch("blackjack");
  expect(a.moves).toBe(b.moves); // determinism guard (observed: 34)
  expect(a.moves).toBe(34);
  expect(a.frames.length).toBeGreaterThan(0);
  expect(a.signCount).toBeGreaterThan(0);
  expect(a.verifyCount).toBeGreaterThan(0);
  expect(a.perMoveBudgetNs).toBeGreaterThan(0);
  expect(a.cryptoSecret.length).toBe(32);
  // captured frames are real and decodable through the engine
  const f = decodeFrame(a.frames[0], bigintSafeCodec);
  expect(f.kind === "move" || f.kind === "ack").toBe(true);
}, 60_000);
