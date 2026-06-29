/**
 * Move (de)serializer for the PvP relay. CRITICAL fairness property: the `commit` move's
 * `localSecret` (the pre-image of the commitment) is DROPPED on encode, so the opponent only
 * ever receives the 32-byte commitment — never the value/salt — until the reveal phase. Without
 * this codec the tunnel falls back to the identity codec and the whole move (pre-image included)
 * would be relayed at commit time, letting the opponent pick a card-biasing reveal. Pass this as
 * the tunnel's `moveCodec`. Binary fields are hex-encoded for the JSON frame envelope.
 */
import { fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import type { BetBlackjackMove } from "./bjBetProtocol";

/** Decode a hex field with a clear, attributable error at the trust boundary. A hostile/garbled
 *  peer frame (missing field, non-string, wrong length) is rejected here, not later as a cryptic
 *  `fromHex(undefined)` or a silent zero-length buffer that only fails commitment verification. */
function bytesFromHex(
  value: unknown,
  label: string,
  length?: number,
): Uint8Array {
  if (typeof value !== "string")
    throw new Error(`${label} must be a hex string`);
  const bytes = fromHex(value);
  if (length !== undefined && bytes.length !== length)
    throw new Error(`${label} must be ${length} bytes, got ${bytes.length}`);
  return bytes;
}

export const bjMoveCodec: MoveCodec<BetBlackjackMove> = {
  encode(m) {
    switch (m.action) {
      case "bet":
        return { action: "bet", amount: m.amount };
      case "commit":
        // localSecret is intentionally omitted — only the commitment crosses the wire.
        return { action: "commit", commitment: toHex(m.commitment) };
      case "reveal":
        return {
          action: "reveal",
          reveal: { value: toHex(m.reveal.value), salt: toHex(m.reveal.salt) },
        };
      case "hit":
      case "stand":
      case "forfeit":
        return { action: m.action };
    }
  },
  decode(j) {
    const o = j as {
      action: string;
      amount?: number;
      commitment?: string;
      reveal?: { value?: string; salt?: string };
    };
    switch (o.action) {
      case "bet":
        if (typeof o.amount !== "number" || !Number.isInteger(o.amount))
          throw new Error("bet.amount must be an integer");
        return { action: "bet", amount: o.amount };
      case "commit":
        return {
          action: "commit",
          commitment: bytesFromHex(o.commitment, "commit.commitment", 32),
        };
      case "reveal": {
        if (!o.reveal || typeof o.reveal !== "object")
          throw new Error("reveal.reveal must be an object");
        return {
          action: "reveal",
          reveal: {
            value: bytesFromHex(o.reveal.value, "reveal.value"),
            salt: bytesFromHex(o.reveal.salt, "reveal.salt"),
          },
        };
      }
      case "hit":
        return { action: "hit" };
      case "stand":
        return { action: "stand" };
      case "forfeit":
        return { action: "forfeit" };
      default:
        throw new Error(`unsupported blackjack move action ${o.action}`);
    }
  },
};
