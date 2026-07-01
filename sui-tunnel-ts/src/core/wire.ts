/**
 * Canonical signed-message wire format for the Sui Tunnel Framework.
 *
 * These functions MUST produce bytes byte-identical to the Move serializers in
 * `sui_tunnel/sources/tunnel.move` (`serialize_state_update` / `serialize_settlement`
 * / `serialize_htlc_lock`) and `signature.move` (`u64_to_be_bytes`). If they diverge,
 * dual signatures verify off-chain but FAIL at on-chain settlement/dispute — a bug that
 * only surfaces when money is at stake. This is cross-checked against Move by
 * `sui_tunnel/tests/wire_format_tests.move` (shared golden vectors).
 *
 * Load-bearing invariants (see tunnel.move:1908-1940, signature.move:447):
 *  - Domain prefixes are inlined ASCII bytes with NO length prefix.
 *  - All u64 fields are 8-byte BIG-ENDIAN (NOT BCS little-endian).
 *  - `state_update` and `settlement` use DIFFERENT field orderings:
 *      state_update: id, state_hash, nonce, timestamp, balA, balB
 *      settlement:   id, balA, balB, final_nonce, timestamp
 *  - ed25519/BLS verify the RAW message (no pre-hash). Only `state_hash` is itself a digest.
 */

import { concatBytes, toHex } from "./bytes";

const enc = new TextEncoder();

/** `b"sui_tunnel::state_update"` — 24 bytes. */
export const DOMAIN_STATE_UPDATE = enc.encode("sui_tunnel::state_update");
/** `b"sui_tunnel::settlement"` — 22 bytes. */
export const DOMAIN_SETTLEMENT = enc.encode("sui_tunnel::settlement");
/** `b"sui_tunnel::settlement_v2"` — 25 bytes (root-anchored settlement). */
export const DOMAIN_SETTLEMENT_V2 = enc.encode("sui_tunnel::settlement_v2");
/** `b"sui_tunnel::htlc_lock"` — 21 bytes. */
export const DOMAIN_HTLC_LOCK = enc.encode("sui_tunnel::htlc_lock");
/** `b"sui_tunnel::spend_authorization"` — 31 bytes (agent allowance voucher). */
export const DOMAIN_SPEND_AUTHORIZATION = enc.encode(
  "sui_tunnel::spend_authorization"
);
/** `b"sui_tunnel::referee_assignment"` — 30 bytes (co-signed referee assignment). */
export const DOMAIN_REFEREE_ASSIGNMENT = enc.encode(
  "sui_tunnel::referee_assignment"
);

const U64_MAX = (1n << 64n) - 1n;

function asU64(value: bigint | number): bigint {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v > U64_MAX) throw new RangeError(`u64 out of range: ${v}`);
  return v;
}

/** 8-byte big-endian encoding of a u64, matching `signature::u64_to_be_bytes`. */
export function u64ToBeBytes(value: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, asU64(value), false);
  return out;
}

/** Read the big-endian u64 at `offset`. Inverse of {@link u64ToBeBytes}. */
export function u64FromBeBytes(bytes: Uint8Array, offset = 0): bigint {
  if (offset < 0 || offset + 8 > bytes.length)
    throw new RangeError(`u64 read out of range at offset ${offset}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getBigUint64(offset, false);
}

/**
 * 32-byte representation of a Sui address / object ID, matching `ID.to_bytes()` /
 * `address.to_bytes()` (left-zero-padded big-endian). Accepts with or without `0x`.
 */
export function addressToBytes32(addr: string): Uint8Array {
  let h = addr.startsWith("0x") || addr.startsWith("0X") ? addr.slice(2) : addr;
  if (!/^[0-9a-fA-F]*$/.test(h))
    throw new Error(`invalid hex address: ${addr}`);
  if (h.length > 64) throw new Error(`address longer than 32 bytes: ${addr}`);
  h = h.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// ============================================
// STATE UPDATE  (the off-chain hot-path message)
// ============================================

export interface StateUpdate {
  /** Tunnel object ID (0x-hex, 32 bytes). */
  tunnelId: string;
  /** Commitment to off-chain app state (typically a 32-byte blake2b256). */
  stateHash: Uint8Array;
  nonce: bigint;
  timestamp: bigint;
  partyABalance: bigint;
  partyBBalance: bigint;
}

/**
 * Serialize the message both parties co-sign to assign an external referee. Byte-exact with
 * Move `tunnel::serialize_referee_assignment`: `DOMAIN || tunnel_id(32) || referee(32)`, no length
 * prefixes. Each party signs this with their tunnel key; the two signatures authorize
 * `set_referee_cosigned` / `entry_set_referee` (see `txbuilders.buildSetReferee`).
 */
export function serializeRefereeAssignment(
  tunnelId: string,
  referee: string
): Uint8Array {
  return concatBytes([
    DOMAIN_REFEREE_ASSIGNMENT,
    addressToBytes32(tunnelId),
    addressToBytes32(referee),
  ]);
}

/** Serialize a state update for signing. Mirrors `tunnel::serialize_state_update`. */
export function serializeStateUpdate(u: StateUpdate): Uint8Array {
  return concatBytes([
    DOMAIN_STATE_UPDATE,
    addressToBytes32(u.tunnelId),
    u.stateHash,
    u64ToBeBytes(u.nonce),
    u64ToBeBytes(u.timestamp),
    u64ToBeBytes(u.partyABalance),
    u64ToBeBytes(u.partyBBalance),
  ]);
}

/** Fixed serialized length: domain(24) + id(32) + state_hash(32) + 4×u64(32). */
const STATE_UPDATE_LEN = DOMAIN_STATE_UPDATE.length + 32 + 32 + 4 * 8;

/**
 * Parse a serialized state update, the inverse of {@link serializeStateUpdate}.
 * Assumes the canonical 32-byte state hash and validates the domain prefix.
 */
export function parseStateUpdate(message: Uint8Array): StateUpdate {
  if (message.length !== STATE_UPDATE_LEN)
    throw new Error(
      `state update must be ${STATE_UPDATE_LEN} bytes, got ${message.length}`
    );
  for (let i = 0; i < DOMAIN_STATE_UPDATE.length; i++)
    if (message[i] !== DOMAIN_STATE_UPDATE[i])
      throw new Error("state update domain prefix mismatch");
  let o = DOMAIN_STATE_UPDATE.length;
  const tunnelId = "0x" + toHex(message.slice(o, o + 32));
  o += 32;
  const stateHash = message.slice(o, o + 32);
  o += 32;
  const nonce = u64FromBeBytes(message, o);
  const timestamp = u64FromBeBytes(message, o + 8);
  const partyABalance = u64FromBeBytes(message, o + 16);
  const partyBBalance = u64FromBeBytes(message, o + 24);
  return {
    tunnelId,
    stateHash,
    nonce,
    timestamp,
    partyABalance,
    partyBBalance,
  };
}

// ============================================
// SETTLEMENT
// ============================================

export interface Settlement {
  tunnelId: string;
  partyABalance: bigint;
  partyBBalance: bigint;
  finalNonce: bigint;
  timestamp: bigint;
}

/** Serialize settlement data for signing. Mirrors `tunnel::serialize_settlement`. */
export function serializeSettlement(s: Settlement): Uint8Array {
  return concatBytes([
    DOMAIN_SETTLEMENT,
    addressToBytes32(s.tunnelId),
    u64ToBeBytes(s.partyABalance),
    u64ToBeBytes(s.partyBBalance),
    u64ToBeBytes(s.finalNonce),
    u64ToBeBytes(s.timestamp),
  ]);
}

export interface SettlementWithRoot extends Settlement {
  /** 32-byte Merkle root over the off-chain transcript (proof-of-existence anchor). */
  transcriptRoot: Uint8Array;
}

/** Serialize root-anchored settlement. Mirrors `tunnel::serialize_settlement_with_root`. */
export function serializeSettlementWithRoot(s: SettlementWithRoot): Uint8Array {
  if (s.transcriptRoot.length !== 32) {
    throw new Error(
      `transcript root must be 32 bytes, got ${s.transcriptRoot.length}`
    );
  }
  return concatBytes([
    DOMAIN_SETTLEMENT_V2,
    addressToBytes32(s.tunnelId),
    u64ToBeBytes(s.partyABalance),
    u64ToBeBytes(s.partyBBalance),
    u64ToBeBytes(s.finalNonce),
    u64ToBeBytes(s.timestamp),
    s.transcriptRoot,
  ]);
}

// ============================================
// HTLC LOCK
// ============================================

export interface HtlcLock {
  tunnelId: string;
  paymentHash: Uint8Array;
  amount: bigint;
  sender: string;
  receiver: string;
  expiryMs: bigint;
}

/** Serialize HTLC lock data for signing. Mirrors `tunnel::serialize_htlc_lock`. */
export function serializeHtlcLock(h: HtlcLock): Uint8Array {
  return concatBytes([
    DOMAIN_HTLC_LOCK,
    addressToBytes32(h.tunnelId),
    h.paymentHash,
    u64ToBeBytes(h.amount),
    addressToBytes32(h.sender),
    addressToBytes32(h.receiver),
    u64ToBeBytes(h.expiryMs),
  ]);
}

// ============================================
// SPEND AUTHORIZATION  (agent allowance voucher)
// ============================================

export interface SpendAuthorization {
  /** Allowance object ID (0x-hex, 32 bytes). */
  allowanceId: string;
  /** Cumulative amount the principal authorizes the payee to have pulled. */
  authorizedTotal: bigint;
}

/**
 * Serialize a cumulative spend voucher for signing by the principal. Mirrors
 * `agent_allowance::serialize_spend_authorization`. The principal signs
 * the RAW bytes (ed25519, no pre-hash); domain separation + the allowance id
 * prevent cross-allowance replay, and the monotonic `authorizedTotal` supersedes
 * any lower voucher on-chain.
 */
export function serializeSpendAuthorization(a: SpendAuthorization): Uint8Array {
  return concatBytes([
    DOMAIN_SPEND_AUTHORIZATION,
    addressToBytes32(a.allowanceId),
    u64ToBeBytes(a.authorizedTotal),
  ]);
}

// ============================================
// ZERO-ALLOCATION HOT-PATH WRITER
// ============================================

/**
 * Minimal-allocation serializer for the state-update hot path (Deliverable 5).
 *
 * The constant prefix (`domain || tunnelId`) is computed once per tunnel; each
 * `write()` mutates only the tail (state_hash + 4 u64s) of a single reused buffer.
 * Output is byte-identical to {@link serializeStateUpdate}.
 *
 * WARNING: `write()` returns the SHARED internal buffer. Sign/copy it before the
 * next `write()` — do not retain the reference across calls.
 */
export class StateUpdateWriter {
  private readonly buf: Uint8Array;
  private readonly dv: DataView;
  private readonly tailOffset: number;
  readonly stateHashLen: number;

  constructor(tunnelId: string, stateHashLen = 32) {
    this.stateHashLen = stateHashLen;
    const prefixLen = DOMAIN_STATE_UPDATE.length + 32;
    this.buf = new Uint8Array(prefixLen + stateHashLen + 32);
    this.buf.set(DOMAIN_STATE_UPDATE, 0);
    this.buf.set(addressToBytes32(tunnelId), DOMAIN_STATE_UPDATE.length);
    this.tailOffset = prefixLen;
    this.dv = new DataView(this.buf.buffer);
  }

  write(
    stateHash: Uint8Array,
    nonce: bigint,
    timestamp: bigint,
    partyABalance: bigint,
    partyBBalance: bigint
  ): Uint8Array {
    if (stateHash.length !== this.stateHashLen) {
      throw new Error(
        `stateHash length ${stateHash.length} != configured ${this.stateHashLen}`
      );
    }
    let o = this.tailOffset;
    this.buf.set(stateHash, o);
    o += this.stateHashLen;
    this.dv.setBigUint64(o, asU64(nonce), false);
    o += 8;
    this.dv.setBigUint64(o, asU64(timestamp), false);
    o += 8;
    this.dv.setBigUint64(o, asU64(partyABalance), false);
    o += 8;
    this.dv.setBigUint64(o, asU64(partyBBalance), false);
    return this.buf;
  }
}
