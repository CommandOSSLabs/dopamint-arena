/**
 * Minimal byte utilities for the off-chain hot path.
 *
 * Kept dependency-free (no @mysten client, no network) so `core/*` can run in
 * workers and tight loops with predictable allocation behavior.
 */

/** Concatenate byte arrays into a single freshly-allocated Uint8Array. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (let i = 0; i < parts.length; i++) len += parts[i].length;
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], o);
    o += parts[i].length;
  }
  return out;
}

/** Constant-ish length-aware equality (not timing-safe; for protocol checks, not secrets). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0")
);

/** Lowercase hex without 0x prefix. */
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

/** Parse hex (optional 0x prefix) into bytes. Throws on odd length / non-hex. */
export function fromHex(hex: string): Uint8Array {
  let h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return out;
}
