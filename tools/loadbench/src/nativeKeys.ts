import { generateKeyPairSync } from "node:crypto";
import { SignatureScheme, ed25519Address, type KeyPair } from "../../../sui-tunnel-ts/src/core/crypto";
import type { Participant } from "../../../sui-tunnel-ts/src/core/keys";

/**
 * Mint an ephemeral ed25519 participant via Bun's BoringSSL (`node:crypto`)
 * instead of @noble. The bench runs on Bun, where native keygen is ~6× faster
 * than @noble's pure-JS scalar mult — and the per-match keypair pair is the only
 * remaining non-native crypto on the hot path (sign/verify already route through
 * the native backend). Keys are standard RFC-8032 ed25519: the 32-byte seed (`d`)
 * and public key (`x`) come straight off the JWK export, so signatures stay
 * byte-identical to @noble and on-chain acceptance is unchanged.
 */
export function nativeParticipant(id: string): Participant {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const keyPair: KeyPair = {
    secretKey: new Uint8Array(Buffer.from(jwk.d, "base64url")),
    publicKey: new Uint8Array(Buffer.from(jwk.x, "base64url")),
    scheme: SignatureScheme.ED25519,
  };
  return { id, address: ed25519Address(keyPair.publicKey), keyPair };
}
