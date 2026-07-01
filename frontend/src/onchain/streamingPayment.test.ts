import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCreateStreamTx,
  computeAvailable,
  computeLocked,
  computeUnlocked,
  ratePerSecond,
  streamStatusName,
  StreamStatus,
  topUpAmountFor,
  type StreamFields,
} from "./streamingPayment.ts";

const COIN = "0xabc::mtps::MTPS";

// 1000-unit stream over 100s (start=0, end=100_000ms), nothing withdrawn yet.
const stream = (over: Partial<StreamFields> = {}): StreamFields => ({
  id: "0x1",
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

test("nothing is unlocked before the stream starts", () => {
  const s = stream({ startMs: 50_000n, endMs: 150_000n });
  assert.equal(computeUnlocked(s, 0n), 0n);
  assert.equal(computeUnlocked(s, 50_000n), 0n);
});

test("unlock is linear between start and end", () => {
  const s = stream();
  assert.equal(computeUnlocked(s, 25_000n), 250n); // 25%
  assert.equal(computeUnlocked(s, 50_000n), 500n); // 50%
});

test("the full amount is unlocked at and after end", () => {
  const s = stream();
  assert.equal(computeUnlocked(s, 100_000n), 1000n);
  assert.equal(computeUnlocked(s, 999_000n), 1000n);
});

test("available is unlocked minus already-withdrawn", () => {
  const s = stream({ withdrawnAmount: 200n });
  // At 50s, 500 unlocked; 200 withdrawn -> 300 available.
  assert.equal(computeAvailable(s, 50_000n), 300n);
});

test("locked is the not-yet-unlocked remainder", () => {
  const s = stream();
  assert.equal(computeLocked(s, 25_000n), 750n);
  assert.equal(computeLocked(s, 100_000n), 0n);
});

test("rate per second is total over duration", () => {
  // 1000 over 100s = 10/s.
  assert.equal(ratePerSecond(stream()), 10n);
});

test("a constant-rate top-up never lowers the unlock curve", () => {
  const s = stream();
  // Extending 50s at the same rate adds total*added/duration = 1000*50000/100000 = 500.
  assert.equal(topUpAmountFor(s, 50_000n), 500n);
});

test("status names map to their codes", () => {
  assert.equal(streamStatusName(StreamStatus.ACTIVE), "Active");
  assert.equal(streamStatusName(StreamStatus.COMPLETED), "Completed");
  assert.equal(streamStatusName(StreamStatus.CANCELLED), "Cancelled");
});

test("create stream stakes from sender address balance (ADR-0013)", () => {
  const tx = buildCreateStreamTx({
    stakeFromBalance: { amount: 100n, coinType: COIN },
    totalAmount: 100n,
    recipient: "0xb",
    durationMs: 3_600_000n,
  });
  const data = tx.getData();

  const withdrawal = data.inputs.find((i) => i.$kind === "FundsWithdrawal");
  assert.ok(withdrawal, "the PTB carries a FundsWithdrawal input");
  assert.equal(
    (withdrawal as { FundsWithdrawal: { withdrawFrom: { $kind: string } } })
      .FundsWithdrawal.withdrawFrom.$kind,
    "Sender",
  );

  const hasRedeem = data.commands.some(
    (c) => c.$kind === "MoveCall" && c.MoveCall.function === "redeem_funds",
  );
  assert.ok(hasRedeem, "escrow coin comes from coin::redeem_funds");

  const hasCreate = data.commands.some(
    (c) => c.$kind === "MoveCall" && c.MoveCall.function === "create_stream",
  );
  assert.ok(hasCreate, "the PTB calls create_stream");
});
