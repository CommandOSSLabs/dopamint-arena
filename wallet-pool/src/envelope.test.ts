import { test } from "node:test";
import assert from "node:assert/strict";
import { seal, unseal } from "./envelope";
import { generateAccessValue, randomBytes } from "./crypto";
import { WrongAccessValueError } from "./errors";

const aad = new TextEncoder().encode("wallet-pool:1:wp_x:mainnet");

test("generated-key round-trip", () => {
  const access = generateAccessValue();
  const pt = randomBytes(64);
  assert.deepEqual(unseal(seal(pt, access, "generated", aad), access, aad), pt);
});

test("passphrase round-trip", () => {
  const access = "correct horse battery staple";
  const pt = randomBytes(32);
  assert.deepEqual(
    unseal(seal(pt, access, "passphrase", aad), access, aad),
    pt,
  );
});

test("wrong access value throws", () => {
  const env = seal(randomBytes(32), generateAccessValue(), "generated", aad);
  assert.throws(
    () => unseal(env, generateAccessValue(), aad),
    WrongAccessValueError,
  );
});

test("tampered aad throws", () => {
  const env = seal(randomBytes(32), generateAccessValue(), "generated", aad);
  const other = new TextEncoder().encode("wallet-pool:1:wp_x:testnet");
  assert.throws(
    () => unseal(env, generateAccessValue(), other),
    WrongAccessValueError,
  );
});

test("passphrase unseal succeeds repeatedly", () => {
  const access = "correct horse battery staple";
  const pt = randomBytes(32);
  const env = seal(pt, access, "passphrase", aad);
  assert.deepEqual(unseal(env, access, aad), pt);
  assert.deepEqual(unseal(env, access, aad), pt);
});

test("wrong passphrase still fails after a correct unseal", () => {
  const access = "correct horse battery staple";
  const pt = randomBytes(32);
  const env = seal(pt, access, "passphrase", aad);
  assert.deepEqual(unseal(env, access, aad), pt);
  assert.throws(
    () => unseal(env, "wrong passphrase", aad),
    WrongAccessValueError,
  );
});
