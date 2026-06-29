import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializeBlob,
  parseBlob,
  aadFor,
  encodeMembers,
  decodeMemberSecret,
} from "./blob";
import type { PoolBlob } from "./types";
import { generateKeyPair } from "./crypto";

const sample: PoolBlob = {
  version: 1,
  walletPoolId: "wp_abc",
  network: "mainnet",
  createdAt: 0,
  coinTypes: ["0x2::sui::SUI"],
  crypto: { mode: "generated", nonce: "n", tag: "t", ciphertext: "c" },
  index: [
    {
      role: "master",
      address: "0x1",
      ordinal: 0,
      createdAt: 0,
      enabled: true,
      useCount: 0,
      lastUsedAt: 0,
    },
  ],
};

test("blob round-trips", () => {
  assert.deepEqual(parseBlob(serializeBlob(sample)), sample);
});

test("aadFor is deterministic and identity-bound", () => {
  assert.deepEqual(aadFor(sample), aadFor(sample));
  assert.notDeepEqual(
    aadFor(sample),
    aadFor({ ...sample, network: "testnet" }),
  );
});

test("members encode/decode round-trips", () => {
  const kp = generateKeyPair();
  const enc = encodeMembers(kp.secretKey, [
    { ordinal: 1, secret: kp.secretKey },
  ]);
  assert.deepEqual(decodeMemberSecret(enc.members[0]), kp.secretKey);
});
