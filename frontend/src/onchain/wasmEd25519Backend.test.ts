import test from "node:test";
import assert from "node:assert/strict";
import { nobleBackend, generateKeyPair } from "sui-tunnel-ts/core/crypto";
import { initWasmEd25519Backend } from "./wasmEd25519Backend";

// The whole safety argument for swapping @noble -> libsodium rests on ed25519 being deterministic:
// any correct RFC-8032 implementation produces the SAME signature bytes, so the on-chain-anchored
// transcript root is unchanged. This test is that contract — if libsodium ever diverged from
// @noble, the swap would silently produce signatures the chain (verified against @noble vectors)
// could reject. Mutual cross-verify guards the verify path too.
test("libsodium WASM ed25519 is byte-identical to @noble (transcript/on-chain safe)", async () => {
  const wasm = await initWasmEd25519Backend();
  for (let i = 0; i < 8; i++) {
    const kp = generateKeyPair();
    const msg = new Uint8Array(64).map((_, j) => (i * 31 + j) & 0xff);

    const nobleSig = nobleBackend.makeSigner(kp.secretKey)(msg);
    const wasmSig = wasm.makeSigner(kp.secretKey)(msg);
    assert.deepStrictEqual(
      wasmSig,
      nobleSig,
      "signature bytes diverge from @noble",
    );

    assert.ok(
      nobleBackend.makeVerifier(kp.publicKey)(msg, wasmSig),
      "@noble rejects a libsodium signature",
    );
    assert.ok(
      wasm.makeVerifier(kp.publicKey)(msg, nobleSig),
      "libsodium rejects a @noble signature",
    );
  }
});
