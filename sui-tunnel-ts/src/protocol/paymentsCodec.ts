/**
 * Payments move codec for the relay. `PaymentMove.amount` is a bigint — JSON frames
 * carry it as a decimal string (same pattern as blackjack `bet` moves).
 */
import type { MoveCodec } from "../core/distributedFrame";
import type { Party } from "./Protocol";
import type { PaymentMove } from "./payments";

export type PaymentMoveJson = { from: Party; amount: string };

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectParty(value: unknown, label: string): Party {
  if (value !== "A" && value !== "B") {
    throw new Error(`${label} must be A or B`);
  }
  return value;
}

function expectAmountString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

export function paymentMoveToJson(move: PaymentMove): PaymentMoveJson {
  return { from: move.from, amount: move.amount.toString() };
}

export function paymentMoveFromJson(value: unknown): PaymentMove {
  const move = expectRecord(value, "move");
  return {
    from: expectParty(move.from, "move.from"),
    amount: BigInt(expectAmountString(move.amount, "move.amount")),
  };
}

export const paymentsMoveCodec: MoveCodec<PaymentMove> = {
  encode: paymentMoveToJson,
  decode: paymentMoveFromJson,
};