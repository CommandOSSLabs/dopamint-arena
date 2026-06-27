/**
 * Move (de)serializer for the v2 `BlackjackProtocol` over the PvP relay. CRITICAL fairness
 * property: the `commit` move's `localSecret` (the card pre-image) is DROPPED on encode, so the
 * opponent only ever receives the 32-byte commitment until the reveal phase. Without this codec a
 * DistributedTunnel falls back to the identity codec and would relay the pre-image at commit time,
 * letting the opponent pick a card-biasing reveal. `BlackjackProtocol.movesCarrySecrets` makes a
 * DistributedTunnel REFUSE to run without it. Pass this as the tunnel's `moveCodec`.
 */
import { fromHex, toHex } from "../core/bytes";
import type { MoveCodec } from "../core/distributedFrame";
import type { BlackjackMove, BlackjackSlotReveal } from "./blackjack";

function revealToJson(r: BlackjackSlotReveal) {
  return { value: toHex(r.value), salt: toHex(r.salt) };
}

/** Decode a hex field with a clear, attributable error at the trust boundary. A hostile/garbled
 *  peer frame (missing field, non-string, wrong length) is rejected here, not later as a cryptic
 *  `fromHex(undefined)` or a silent zero-length buffer that only fails commitment verification. */
function bytesFromHex(value: unknown, label: string, length?: number): Uint8Array {
  if (typeof value !== "string") throw new Error(`${label} must be a hex string`);
  const bytes = fromHex(value);
  if (length !== undefined && bytes.length !== length)
    throw new Error(`${label} must be ${length} bytes, got ${bytes.length}`);
  return bytes;
}

export function blackjackMoveToJson(move: BlackjackMove): unknown {
  switch (move.kind) {
    case "commit":
      // localSecret intentionally omitted — only the commitment crosses the wire.
      return { kind: "commit", commitment: toHex(move.commitment) };
    case "reveal":
      return { kind: "reveal", reveal: revealToJson(move.reveal) };
    case "deal":
    case "hit":
    case "stand":
    case "forfeit":
      return { kind: move.kind };
  }
}

export function blackjackMoveFromJson(value: unknown): BlackjackMove {
  const o = value as {
    kind: string;
    commitment?: string;
    reveal?: { value?: string; salt?: string };
  };
  switch (o.kind) {
    case "commit":
      return {
        kind: "commit",
        commitment: bytesFromHex(o.commitment, "commit.commitment", 32),
      };
    case "reveal": {
      if (!o.reveal || typeof o.reveal !== "object")
        throw new Error("reveal.reveal must be an object");
      return {
        kind: "reveal",
        reveal: {
          value: bytesFromHex(o.reveal.value, "reveal.value"),
          salt: bytesFromHex(o.reveal.salt, "reveal.salt"),
        },
      };
    }
    case "deal":
      return { kind: "deal" };
    case "hit":
      return { kind: "hit" };
    case "stand":
      return { kind: "stand" };
    case "forfeit":
      return { kind: "forfeit" };
    default:
      throw new Error(`unsupported blackjack move kind ${o.kind}`);
  }
}

export const blackjackMoveCodec: MoveCodec<BlackjackMove> = {
  encode: blackjackMoveToJson,
  decode: blackjackMoveFromJson,
};
