import assert from "node:assert/strict";
import { test } from "node:test";
import { toHex } from "../core/bytes";
import { commitSlotSecrets, PokerMove, SlotSecret } from "./quantumPoker";
import {
  pokerMoveCodec,
  pokerMoveFromJson,
  pokerMoveToJson,
} from "./quantumPokerCodec";

function secrets(base: number): SlotSecret[] {
  return Array.from({ length: 9 }, (_, slot) => ({
    value: Uint8Array.from({ length: 32 }, (_, i) => (base + slot + i) & 0xff),
    salt: Uint8Array.from(
      { length: 16 },
      (_, i) => (base * 7 + slot + i) & 0xff,
    ),
  }));
}

function assertRoundTrip(move: PokerMove): void {
  const decoded = pokerMoveFromJson(pokerMoveToJson(move));
  if (move.kind === "commit_slots") {
    assert.equal(decoded.kind, "commit_slots");
    assert.deepEqual(decoded.commitments, move.commitments);
    assert.equal(Object.hasOwn(decoded, "localSecrets"), false);
    return;
  }
  assert.deepEqual(decoded, move);
}

test("PokerMoveCodec round-trips byte and bigint moves", () => {
  const s = secrets(10);
  const moves: PokerMove[] = [
    {
      kind: "commit_slots",
      commitments: commitSlotSecrets(s),
      localSecrets: s,
    },
    { kind: "reveal_slots", slots: [2, 3], reveals: [s[2], s[3]] },
    { kind: "bet", amount: 123n },
    { kind: "check" },
    { kind: "call" },
    { kind: "fold" },
    { kind: "next_hand" },
  ];

  for (const move of moves) assertRoundTrip(move);
});

test("PokerMoveCodec omits local commit secrets from relay JSON", () => {
  const s = secrets(1);
  const move: PokerMove = {
    kind: "commit_slots",
    commitments: commitSlotSecrets(s),
    localSecrets: s,
  };
  const encoded = pokerMoveCodec.encode(move);
  assert.equal(JSON.stringify(encoded).includes("localSecrets"), false);
  assert.equal(JSON.stringify(encoded).includes(toHex(s[0].value)), false);
  const decoded = pokerMoveCodec.decode(encoded);
  assert.equal(decoded.kind, "commit_slots");
  assert.equal(Object.hasOwn(decoded, "localSecrets"), false);
});

test("PokerMoveCodec rejects malformed payloads", () => {
  assert.throws(() => pokerMoveFromJson(null), /object/);
  assert.throws(
    () => pokerMoveFromJson({ kind: "commit_slots", commitments: ["0x01"] }),
    /32 bytes/,
  );
  assert.throws(() => pokerMoveFromJson({ kind: "bet", amount: 7 }), /string/);
});
