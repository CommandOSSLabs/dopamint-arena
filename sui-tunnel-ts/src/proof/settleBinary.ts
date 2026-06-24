/**
 * Binary /settle body (octet-stream) — replaces JSON+hex so 16 MB holds ~2× the moves
 * and the Walrus blob shrinks the same. Fixed-offset header + length-prefixed entries; see
 * docs/superpowers/specs/2026-06-24-settle-binary-transcript-design.md for the layout. The
 * Rust backend parses the SAME bytes (golden-vector-pinned for parity). The single leading
 * version byte is a cheap guard that rejects a wrong/garbage body with a clean error.
 */
import { concatBytes, toHex } from "../core/bytes";
import { u64ToBeBytes, u64FromBeBytes } from "../core/wire";

export const SETTLE_BODY_VERSION = 0x01;
const HEADER_LEN = 229;

export interface SettleBody {
  tunnelId: string; // "0x"-prefixed 32-byte hex
  partyABalance: bigint;
  partyBBalance: bigint;
  finalNonce: bigint;
  timestamp: bigint;
  transcriptRoot: Uint8Array; // 32
  sigA: Uint8Array; // 64 settlement co-sig
  sigB: Uint8Array; // 64
  entries: { message: Uint8Array; sigA: Uint8Array; sigB: Uint8Array }[];
}

function id32(tunnelId: string): Uint8Array {
  const h = tunnelId.startsWith("0x") ? tunnelId.slice(2) : tunnelId;
  const out = new Uint8Array(32);
  const b = h.padStart(64, "0");
  for (let i = 0; i < 32; i++) out[i] = parseInt(b.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function u16(n: number): Uint8Array {
  const o = new Uint8Array(2);
  new DataView(o.buffer).setUint16(0, n, false);
  return o;
}
function u32(n: number): Uint8Array {
  const o = new Uint8Array(4);
  new DataView(o.buffer).setUint32(0, n, false);
  return o;
}

export function encodeSettleBody(b: SettleBody): Uint8Array {
  if (b.transcriptRoot.length !== 32)
    throw new Error("transcriptRoot must be 32 bytes");
  if (b.sigA.length !== 64 || b.sigB.length !== 64)
    throw new Error("settlement sigs must be 64 bytes");
  const parts: Uint8Array[] = [
    new Uint8Array([SETTLE_BODY_VERSION]),
    id32(b.tunnelId),
    u64ToBeBytes(b.partyABalance),
    u64ToBeBytes(b.partyBBalance),
    u64ToBeBytes(b.finalNonce),
    u64ToBeBytes(b.timestamp),
    b.transcriptRoot,
    b.sigA,
    b.sigB,
    u32(b.entries.length),
  ];
  for (const e of b.entries) {
    if (e.sigA.length !== 64 || e.sigB.length !== 64)
      throw new Error("entry sigs must be 64 bytes");
    parts.push(u16(e.message.length), e.message, e.sigA, e.sigB);
  }
  return concatBytes(parts);
}

export function decodeSettleBody(bytes: Uint8Array): SettleBody {
  if (bytes.length < HEADER_LEN) throw new Error("settle body too short");
  if (bytes[0] !== SETTLE_BODY_VERSION)
    throw new Error(`unexpected settle version: ${bytes[0]}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tunnelId = "0x" + toHex(bytes.slice(1, 33));
  const partyABalance = u64FromBeBytes(bytes, 33);
  const partyBBalance = u64FromBeBytes(bytes, 41);
  const finalNonce = u64FromBeBytes(bytes, 49);
  const timestamp = u64FromBeBytes(bytes, 57);
  const transcriptRoot = bytes.slice(65, 97);
  const sigA = bytes.slice(97, 161);
  const sigB = bytes.slice(161, 225);
  const count = dv.getUint32(225, false);
  const entries: SettleBody["entries"] = [];
  let off = HEADER_LEN;
  for (let i = 0; i < count; i++) {
    const msgLen = dv.getUint16(off, false);
    off += 2;
    const message = bytes.slice(off, off + msgLen);
    off += msgLen;
    const eSigA = bytes.slice(off, off + 64);
    off += 64;
    const eSigB = bytes.slice(off, off + 64);
    off += 64;
    entries.push({ message, sigA: eSigA, sigB: eSigB });
  }
  return {
    tunnelId,
    partyABalance,
    partyBBalance,
    finalNonce,
    timestamp,
    transcriptRoot,
    sigA,
    sigB,
    entries,
  };
}
