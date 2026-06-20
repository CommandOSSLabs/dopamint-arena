/**
 * The two PvP wire frames and their opaque-byte codec.
 *
 * A frame is encoded to UTF-8 JSON (u64 as decimal string, bytes as lowercase hex)
 * so the relay can forward it as opaque bytes without parsing any game data. The
 * SIGNED state-update bytes are produced separately by `wire.serializeStateUpdate`
 * and are byte-identical to self-play; this codec is only the transport envelope.
 */
import { fromHex, toHex } from "./bytes";
import type { Party } from "../protocol/Protocol";

/** A proposed move + the proposer's signature half over the state_update message. */
export interface MoveFrame<M> {
  kind: "move";
  nonce: bigint;
  by: Party;
  move: M;
  timestamp: bigint;
  stateHash: Uint8Array;
  partyABalance: bigint;
  partyBBalance: bigint;
  sigProposer: Uint8Array;
}

/** The responder's co-signature over the same state_update message. */
export interface AckFrame {
  kind: "ack";
  nonce: bigint;
  sigResponder: Uint8Array;
}

export type Frame<M> = MoveFrame<M> | AckFrame;

/** Move (de)serializer. The identity codec works whenever `M` is a JSON-native value. */
export interface MoveCodec<M> {
  encode(m: M): unknown;
  decode(j: unknown): M;
}

export const identityMoveCodec: MoveCodec<unknown> = {
  encode: (m) => m,
  decode: (j) => j,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Canonical outer-envelope builder that operates on an already-encoded inner JSON string.
 *
 * Parses `kind` out of the inner JSON and returns the relay envelope
 * `{ t: "frame", kind, data }` where `data` is the inner string kept opaque.
 * This is the single source of truth for outer-envelope assembly; both the
 * SDK helper (`encodeRelayEnvelope`) and the transport send path call here.
 */
export function wrapInnerFrameJson(innerJson: string): string {
  const { kind } = JSON.parse(innerJson) as { kind: string };
  return JSON.stringify({ t: "frame", kind, data: innerJson });
}

/**
 * Build the relay envelope the backend receives: `{ t: "frame", kind, data }`.
 *
 * Stamps `kind` on the outer envelope so the backend reads one JSON field instead of
 * re-parsing the inner `data` string. The inner `data` is the same opaque JSON produced
 * by `encodeFrame`; only the outer wrapper gains the extra field. Legacy backends that
 * do not read the outer `kind` are unaffected — they still find it inside `data`.
 *
 * Delegates to `wrapInnerFrameJson` so there is exactly one place that assembles
 * the outer envelope and extracts `kind`.
 */
export function encodeRelayEnvelope<M>(
  frame: Frame<M>,
  codec: MoveCodec<M>
): string {
  const innerJson = new TextDecoder().decode(encodeFrame(frame, codec));
  return wrapInnerFrameJson(innerJson);
}

export function encodeFrame<M>(
  frame: Frame<M>,
  codec: MoveCodec<M>
): Uint8Array {
  const obj =
    frame.kind === "move"
      ? {
          kind: "move",
          nonce: frame.nonce.toString(),
          by: frame.by,
          move: codec.encode(frame.move),
          timestamp: frame.timestamp.toString(),
          stateHash: toHex(frame.stateHash),
          partyABalance: frame.partyABalance.toString(),
          partyBBalance: frame.partyBBalance.toString(),
          sigProposer: toHex(frame.sigProposer),
        }
      : {
          kind: "ack",
          nonce: frame.nonce.toString(),
          sigResponder: toHex(frame.sigResponder),
        };
  return textEncoder.encode(JSON.stringify(obj));
}

export function decodeFrame<M>(
  bytes: Uint8Array,
  codec: MoveCodec<M>
): Frame<M> {
  const o = JSON.parse(textDecoder.decode(bytes));
  if (o.kind === "move") {
    return {
      kind: "move",
      nonce: BigInt(o.nonce),
      by: o.by,
      move: codec.decode(o.move),
      timestamp: BigInt(o.timestamp),
      stateHash: fromHex(o.stateHash),
      partyABalance: BigInt(o.partyABalance),
      partyBBalance: BigInt(o.partyBBalance),
      sigProposer: fromHex(o.sigProposer),
    };
  }
  if (o.kind === "ack") {
    return {
      kind: "ack",
      nonce: BigInt(o.nonce),
      sigResponder: fromHex(o.sigResponder),
    };
  }
  throw new Error(`unknown frame kind: ${o.kind}`);
}
