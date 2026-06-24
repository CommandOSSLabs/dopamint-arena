// Faster browser crypto for the self-play hot loop: libsodium (WASM) ed25519, conforming to the
// SDK's CryptoBackend. Installed once at boot as the SDK's default backend, so EVERY
// OffchainTunnel.selfPlay — current and future games — uses it with no per-call wiring.
//
// In the browser defaultBackend() otherwise falls back to pure-JS @noble (node:crypto is stubbed).
// libsodium's WASM sign/verify run at native speed and are SYNCHRONOUS after init — which is why
// this fits the engine's synchronous SignFn/VerifyFn where WebCrypto (async-only) cannot. Signatures
// are standard RFC-8032, byte-identical to @noble (deterministic), so the transcript root and
// on-chain acceptance are unchanged.

import _sodium from "libsodium-wrappers";
import type { CryptoBackend } from "sui-tunnel-ts/core/crypto";
import { setDefaultBackend } from "sui-tunnel-ts/core/crypto-native";

let sodium: typeof _sodium | null = null;

export const wasmEd25519Backend: CryptoBackend = {
  name: "wasm-libsodium",
  makeSigner: (secretKey) => {
    if (!sodium)
      throw new Error(
        "wasm backend not initialized (await initWasmEd25519Backend)",
      );
    // libsodium wants the 64-byte secret key (seed||pub); expand the 32-byte seed once per signer.
    const { privateKey } = sodium.crypto_sign_seed_keypair(secretKey);
    return (message) => sodium!.crypto_sign_detached(message, privateKey);
  },
  makeVerifier: (publicKey) => {
    if (!sodium)
      throw new Error(
        "wasm backend not initialized (await initWasmEd25519Backend)",
      );
    return (message, signature) =>
      sodium!.crypto_sign_verify_detached(signature, message, publicKey);
  },
};

/** Resolve the WASM module (instantiates asynchronously) and return the ready backend. Idempotent. */
export async function initWasmEd25519Backend(): Promise<CryptoBackend> {
  await _sodium.ready;
  sodium = _sodium;
  return wasmEd25519Backend;
}

/**
 * Call once at app boot. Installs the WASM backend as the SDK default once libsodium loads, so all
 * self-play uses it with no per-game wiring. Until it resolves — and permanently if it fails to load
 * (e.g. strict CSP / old browser) — the SDK keeps its @noble default. Node/the fleet is unaffected
 * (it never calls this and keeps its faster OpenSSL backend).
 */
export function installWasmCryptoBackend(): void {
  void initWasmEd25519Backend()
    .then(setDefaultBackend)
    .catch((e) =>
      console.error("[wasm-crypto] init failed; staying on @noble:", e),
    );
}
