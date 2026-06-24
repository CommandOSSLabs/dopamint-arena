import { fromHex, toHex } from "../core/bytes";
import type { MoveCodec } from "../core/distributedFrame";
import type { PokerMove, SlotReveal } from "./quantumPoker";

export type PokerMoveJson =
  | { kind: "commit_slots"; commitments: string[] }
  | { kind: "reveal_slots"; slots: number[]; reveals: SlotRevealJson[] }
  | { kind: "bet"; amount: string }
  | { kind: "check" }
  | { kind: "call" }
  | { kind: "fold" }
  | { kind: "next_hand" };

export interface SlotRevealJson {
  value: string;
  salt: string;
}

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

function expectInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
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

function revealToJson(reveal: SlotReveal): SlotRevealJson {
  return { value: hex(reveal.value), salt: hex(reveal.salt) };
}

function revealFromJson(value: unknown, label: string): SlotReveal {
  const reveal = expectRecord(value, label);
  return {
    value: bytesFromHex(reveal.value, `${label}.value`, 32),
    salt: bytesFromHex(reveal.salt, `${label}.salt`, 16),
  };
}

export function pokerMoveToJson(move: PokerMove): PokerMoveJson {
  switch (move.kind) {
    case "commit_slots":
      return {
        kind: move.kind,
        commitments: move.commitments.map(hex),
      };
    case "reveal_slots":
      return {
        kind: move.kind,
        slots: move.slots.slice(),
        reveals: move.reveals.map(revealToJson),
      };
    case "bet":
      return { kind: move.kind, amount: move.amount.toString() };
    case "check":
    case "call":
    case "fold":
    case "next_hand":
      return { kind: move.kind };
  }
}

export function pokerMoveFromJson(value: unknown): PokerMove {
  const move = expectRecord(value, "move");
  const kind = expectString(move.kind, "move.kind");
  switch (kind) {
    case "commit_slots":
      return {
        kind,
        commitments: expectArray(move.commitments, "move.commitments").map(
          (commitment, i) =>
            bytesFromHex(commitment, `move.commitments[${i}]`, 32),
        ),
      };
    case "reveal_slots":
      return {
        kind,
        slots: expectArray(move.slots, "move.slots").map((slot, i) =>
          expectInteger(slot, `move.slots[${i}]`),
        ),
        reveals: expectArray(move.reveals, "move.reveals").map((reveal, i) =>
          revealFromJson(reveal, `move.reveals[${i}]`),
        ),
      };
    case "bet":
      return { kind, amount: BigInt(expectString(move.amount, "move.amount")) };
    case "check":
    case "call":
    case "fold":
    case "next_hand":
      return { kind };
    default:
      throw new Error(`unsupported poker move kind ${kind}`);
  }
}

export const pokerMoveCodec: MoveCodec<PokerMove> = {
  encode: pokerMoveToJson,
  decode: pokerMoveFromJson,
};
