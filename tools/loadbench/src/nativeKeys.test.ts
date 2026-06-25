import { test, expect } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { defaultBackend } from "../../../sui-tunnel-ts/src/core/crypto-native";
import { ed25519Address } from "../../../sui-tunnel-ts/src/core/crypto";
import { nativeParticipant } from "./nativeKeys";

test("nativeParticipant mints a 32-byte ed25519 identity that verifies on the on-chain path", () => {
  const p = nativeParticipant("p-0");

  expect(p.keyPair.secretKey.length).toBe(32);
  expect(p.keyPair.publicKey.length).toBe(32);
  // The seed must derive exactly this public key (a consistent ed25519 pair).
  expect(Array.from(p.keyPair.publicKey)).toEqual(
    Array.from(ed25519.getPublicKey(p.keyPair.secretKey)),
  );
  expect(p.address).toBe(ed25519Address(p.keyPair.publicKey));

  // A signature from the engine's backend must verify under @noble (the on-chain
  // verifier), proving byte-for-byte parity — the whole point of staying on ed25519.
  const msg = new Uint8Array([9, 8, 7, 6, 5]);
  const sig = defaultBackend().makeSigner(p.keyPair.secretKey)(msg);
  expect(ed25519.verify(sig, msg, p.keyPair.publicKey)).toBe(true);
});

test("nativeParticipant returns a fresh identity each call", () => {
  const a = nativeParticipant("a");
  const b = nativeParticipant("b");
  expect(Array.from(a.keyPair.secretKey)).not.toEqual(Array.from(b.keyPair.secretKey));
});
