import assert from "node:assert/strict";
import test from "node:test";
import { decideReconcile, ResyncView } from "./reconcile";
import { CoSignedUpdate } from "./tunnel";

const cp = (nonce: bigint, hashByte: number): CoSignedUpdate => ({
  update: {
    tunnelId: `0x${"11".repeat(32)}`,
    stateHash: new Uint8Array(32).fill(hashByte),
    nonce,
    timestamp: 0n,
    partyABalance: 1000n,
    partyBBalance: 1000n,
  },
  sigA: new Uint8Array(64),
  sigB: new Uint8Array(64),
});
const view = (
  nonce: bigint,
  hasPending: boolean,
  checkpoint: CoSignedUpdate | null
): ResyncView => ({ nonce, hasPending, checkpoint });

test("peer ahead -> adopt", () => {
  assert.equal(
    decideReconcile(view(1n, false, cp(1n, 1)), view(2n, false, cp(2n, 2)))
      .action,
    "adopt"
  );
});
test("self ahead -> wait (peer adopts mine)", () => {
  assert.equal(
    decideReconcile(view(2n, false, cp(2n, 2)), view(1n, false, cp(1n, 1)))
      .action,
    "wait"
  );
});
test("equal nonce + self has pending -> re-propose", () => {
  assert.equal(
    decideReconcile(view(3n, true, cp(3n, 3)), view(3n, false, cp(3n, 3)))
      .action,
    "re-propose"
  );
});
test("equal nonce + no pending -> noop", () => {
  assert.equal(
    decideReconcile(view(3n, false, cp(3n, 3)), view(3n, false, cp(3n, 3)))
      .action,
    "noop"
  );
});
test("equal nonce + conflicting stateHash -> settle (equivocation)", () => {
  assert.equal(
    decideReconcile(view(3n, true, cp(3n, 3)), view(3n, false, cp(3n, 9)))
      .action,
    "settle"
  );
});
test("equal at nonce 0 with no checkpoints -> noop, not settle", () => {
  assert.equal(
    decideReconcile(view(0n, false, null), view(0n, false, null)).action,
    "noop"
  );
});
