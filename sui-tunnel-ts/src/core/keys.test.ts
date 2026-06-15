import { test } from "node:test";
import assert from "node:assert/strict";
import { ParticipantRegistry, createParticipant } from "./keys";
import { ed25519Address } from "./crypto";

test("createParticipant derives address from its public key", () => {
  const p = createParticipant("user-0");
  assert.equal(p.id, "user-0");
  assert.equal(p.address, ed25519Address(p.keyPair.publicKey));
  assert.ok(p.address.startsWith("0x"));
});

test("registry creates, indexes, and rejects duplicates", () => {
  const r = new ParticipantRegistry();
  const a = r.create("a");
  assert.equal(r.get("a").address, a.address);
  assert.ok(r.has("a"));
  assert.throws(() => r.create("a"));
});

test("createMany produces n distinct identities in order", () => {
  const r = new ParticipantRegistry();
  const agents = r.createMany("agent-", 100);
  assert.equal(agents.length, 100);
  assert.equal(r.size, 100);
  assert.equal(agents[0].id, "agent-0");
  assert.equal(agents[99].id, "agent-99");
  const addrs = new Set(r.all().map((p) => p.address));
  assert.equal(addrs.size, 100);
});
