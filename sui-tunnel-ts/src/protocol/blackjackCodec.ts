/**
 * Blackjack move codec for the relay, mirroring `quantumPokerCodec`. Converts the
 * `Uint8Array` fields of a `BlackjackMove` (commitment, reveal value/salt) to/from hex JSON.
 * A `commit` move's `localSecret` is LOCAL-ONLY and is dropped on encode — the counterparty
 * receives only the commitment.
 */
import { fromHex, toHex } from "../core/bytes";
import type { MoveCodec } from "../core/distributedFrame";
import type { BlackjackMove, BlackjackSlotReveal } from "./blackjack";

export type BlackjackMoveJson =
  | { kind: "bet"; amount: string }
  | { kind: "commit"; commitment: string }
  | { kind: "reveal"; reveal: { value: string; salt: string } }
  | { kind: "hit" }
  | { kind: "stand" }
  | { kind: "forfeit" };

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function bytesFromHex(
  value: unknown,
  label: string,
  length?: number,
): Uint8Array {
  const bytes = fromHex(expectString(value, label));
  if (length !== undefined && bytes.length !== length) {
    throw new Error(`${label} must be ${length} bytes`);
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return "0x" + toHex(bytes);
}

function revealToJson(reveal: BlackjackSlotReveal): {
  value: string;
  salt: string;
} {
  return { value: hex(reveal.value), salt: hex(reveal.salt) };
}

function revealFromJson(value: unknown, label: string): BlackjackSlotReveal {
  const reveal = expectRecord(value, label);
  return {
    value: bytesFromHex(reveal.value, `${label}.value`),
    salt: bytesFromHex(reveal.salt, `${label}.salt`),
  };
}

export function blackjackMoveToJson(move: BlackjackMove): BlackjackMoveJson {
  switch (move.kind) {
    case "bet":
      return { kind: move.kind, amount: move.amount.toString() };
    case "commit":
      // localSecret is intentionally omitted — it never leaves the owning seat.
      return { kind: move.kind, commitment: hex(move.commitment) };
    case "reveal":
      return { kind: move.kind, reveal: revealToJson(move.reveal) };
    case "hit":
    case "stand":
    case "forfeit":
      return { kind: move.kind };
  }
}

export function blackjackMoveFromJson(value: unknown): BlackjackMove {
  const move = expectRecord(value, "move");
  const kind = expectString(move.kind, "move.kind");
  switch (kind) {
    case "bet":
      return { kind, amount: BigInt(expectString(move.amount, "move.amount")) };
    case "commit":
      return {
        kind,
        commitment: bytesFromHex(move.commitment, "move.commitment", 32),
      };
    case "reveal":
      return { kind, reveal: revealFromJson(move.reveal, "move.reveal") };
    case "hit":
    case "stand":
    case "forfeit":
      return { kind };
    default:
      throw new Error(`unsupported blackjack move kind ${kind}`);
  }
}

export const blackjackMoveCodec: MoveCodec<BlackjackMove> = {
  encode: blackjackMoveToJson,
  decode: blackjackMoveFromJson,
};
