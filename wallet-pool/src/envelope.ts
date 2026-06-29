import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  scryptSync,
} from "node:crypto";
import { randomBytes, fromB64, toB64 } from "./crypto";
import { WrongAccessValueError } from "./errors";
import { KeyCache } from "./keycache";

export type AccessMode = "generated" | "passphrase";
const SCRYPT = { N: 16384, r: 8, p: 1 };

/** Session-scoped cache so passphrase pools only run scrypt once per (salt, access value). */
const scryptKeyCache = new KeyCache<Buffer>(64, 300_000);

export interface SealedEnvelope {
  mode: AccessMode;
  kdf?: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  nonce: string;
  tag: string;
  ciphertext: string;
}

function deriveKey(
  accessValue: string,
  env: Pick<SealedEnvelope, "mode" | "kdf">,
): Buffer {
  if (env.mode === "generated") {
    const ikm = Buffer.from(accessValue, "base64url");
    if (ikm.length !== 32) {
      throw new WrongAccessValueError(
        "generated access value must decode to 32 bytes",
      );
    }
    return Buffer.from(
      hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.alloc(0), 32),
    );
  }
  if (!env.kdf)
    throw new WrongAccessValueError("passphrase envelope missing kdf params");
  const { salt, N, r, p } = env.kdf;
  const cacheKey = `${salt}:${accessValue}`;
  const cached = scryptKeyCache.get(cacheKey);
  if (cached) return cached;
  return scryptSync(accessValue, Buffer.from(fromB64(salt)), 32, { N, r, p });
}

export function seal(
  plaintext: Uint8Array,
  accessValue: string,
  mode: AccessMode,
  aad: Uint8Array,
): SealedEnvelope {
  const nonce = randomBytes(12);
  const kdf =
    mode === "passphrase"
      ? { name: "scrypt" as const, salt: toB64(randomBytes(16)), ...SCRYPT }
      : undefined;
  const key = deriveKey(accessValue, { mode, kdf });
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    mode,
    kdf,
    nonce: toB64(nonce),
    tag: toB64(tag),
    ciphertext: toB64(ciphertext),
  };
}

export function unseal(
  env: SealedEnvelope,
  accessValue: string,
  aad: Uint8Array,
): Uint8Array {
  const key = deriveKey(accessValue, env);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(fromB64(env.nonce)),
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(fromB64(env.tag)));
  try {
    const plaintext = new Uint8Array(
      Buffer.concat([
        decipher.update(Buffer.from(fromB64(env.ciphertext))),
        decipher.final(),
      ]),
    );
    if (env.mode === "passphrase" && env.kdf) {
      scryptKeyCache.set(`${env.kdf.salt}:${accessValue}`, key);
    }
    return plaintext;
  } catch {
    throw new WrongAccessValueError();
  }
}
