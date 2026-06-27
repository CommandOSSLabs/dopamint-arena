import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitMoveFromSecret,
  secureCommitSecret,
  type BetBlackjackMove,
} from "./app/lib/bjBetProtocol";
import { bjMoveCodec } from "./app/lib/bjMoveCodec";

test("commit encoding DROPS the pre-image (no value/salt/localSecret on the wire)", () => {
  const move = commitMoveFromSecret(secureCommitSecret());
  const json = bjMoveCodec.encode(move);
  const text = JSON.stringify(json);
  assert.ok(!text.includes("localSecret"), "localSecret leaked to the wire");
  assert.ok(!text.includes("salt"), "salt leaked to the wire");
  assert.ok(!text.includes("value"), "value leaked to the wire");
  assert.deepEqual(Object.keys(json as object).sort(), [
    "action",
    "commitment",
  ]);
});

test("decoded commit has only the commitment (no recoverable secret)", () => {
  const move = commitMoveFromSecret(secureCommitSecret());
  const decoded = bjMoveCodec.decode(bjMoveCodec.encode(move)) as Extract<
    BetBlackjackMove,
    { action: "commit" }
  >;
  assert.equal(decoded.action, "commit");
  assert.equal(decoded.commitment.length, 32);
  assert.equal((decoded as { localSecret?: unknown }).localSecret, undefined);
});

test("reveal / bet / hit / stand / forfeit round-trip", () => {
  const reveal: BetBlackjackMove = {
    action: "reveal",
    reveal: {
      value: Uint8Array.from([1, 2, 3]),
      salt: new Uint8Array(16).fill(7),
    },
  };
  const r = bjMoveCodec.decode(bjMoveCodec.encode(reveal)) as Extract<
    BetBlackjackMove,
    { action: "reveal" }
  >;
  assert.deepEqual(Array.from(r.reveal.value), [1, 2, 3]);
  assert.deepEqual(Array.from(r.reveal.salt), new Array(16).fill(7));

  for (const m of [
    { action: "bet", amount: 250 },
    { action: "hit" },
    { action: "stand" },
    { action: "forfeit" },
  ] as BetBlackjackMove[]) {
    assert.deepEqual(bjMoveCodec.decode(bjMoveCodec.encode(m)), m);
  }
});

test("decode rejects an unknown action and a malformed commitment", () => {
  assert.throws(() => bjMoveCodec.decode({ action: "nope" }), /unsupported/);
  assert.throws(
    () => bjMoveCodec.decode({ action: "commit", commitment: "0x00" }),
    /32 bytes/,
  );
});
