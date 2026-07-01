import { test } from "node:test";
import assert from "node:assert/strict";

import { StreamStatus, type StreamFields } from "@/onchain/streamingPayment";

import { buildTick, displayAccrued, verifyTick } from "./sessionCore";

const stream = (over: Partial<StreamFields> = {}): StreamFields => ({
  id: "0xstream",
  sender: "0xa",
  recipient: "0xb",
  totalAmount: 1000n,
  withdrawnAmount: 0n,
  escrowBalance: 1000n,
  startMs: 0n,
  endMs: 100_000n,
  status: StreamStatus.ACTIVE,
  ...over,
});

test("buildTick matches computeUnlocked at timestamp", () => {
  const s = stream();
  const tick = buildTick(s, 0, 50_000n);
  assert.equal(tick.accruedUnlocked, 500n);
  assert.equal(tick.streamId, "0xstream");
  assert.equal(tick.tickNonce, 0);
});

test("verifyTick accepts valid monotonic ticks", () => {
  const s = stream();
  const t0 = buildTick(s, 0, 25_000n);
  assert.equal(verifyTick(s, t0, null), null);
  const t1 = buildTick(s, 1, 50_000n);
  assert.equal(verifyTick(s, t1, t0), null);
});

test("verifyTick rejects bad nonce and formula", () => {
  const s = stream();
  const t0 = buildTick(s, 0, 25_000n);
  const bad = { ...t0, tickNonce: 2 };
  assert.match(verifyTick(s, bad, t0) ?? "", /nonce/);
  const wrongAmount = { ...t0, accruedUnlocked: 999n };
  assert.match(verifyTick(s, wrongAmount, null) ?? "", /formula/);
});

test("displayAccrued caps at on-chain available", () => {
  assert.equal(displayAccrued(500n, 300n), 300n);
  assert.equal(displayAccrued(200n, 300n), 200n);
});
