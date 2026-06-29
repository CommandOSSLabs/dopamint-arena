import { toB64, fromB64 } from "./crypto";
import type { Network, PoolBlob, SealedMembers } from "./types";

export const BLOB_VERSION = 1 as const;

export function aadFor(b: { version: number; walletPoolId: string; network: Network }): Uint8Array {
  return new TextEncoder().encode(`wallet-pool:${b.version}:${b.walletPoolId}:${b.network}`);
}

export function serializeBlob(blob: PoolBlob): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(blob, null, 2));
}

export function parseBlob(bytes: Uint8Array): PoolBlob {
  const blob = JSON.parse(new TextDecoder().decode(bytes)) as PoolBlob;
  if (blob.version !== BLOB_VERSION) throw new Error(`unsupported blob version ${blob.version}`);
  return blob;
}

export function encodeMembers(
  masterSecret: Uint8Array,
  members: { ordinal: number; secret: Uint8Array }[],
): SealedMembers {
  return {
    masterSecret: toB64(masterSecret),
    members: members.map((m) => ({ ordinal: m.ordinal, secret: toB64(m.secret) })),
  };
}

export function decodeMemberSecret(m: { secret: string }): Uint8Array {
  return fromB64(m.secret);
}
