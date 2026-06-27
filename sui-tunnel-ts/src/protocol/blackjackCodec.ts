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
    case "commit": {
      const commitment = fromHex(o.commitment!);
      if (commitment.length !== 32)
        throw new Error("commit.commitment must be 32 bytes");
      return { kind: "commit", commitment };
    }
    case "reveal":
      return {
        kind: "reveal",
        reveal: {
          value: fromHex(o.reveal!.value!),
          salt: fromHex(o.reveal!.salt!),
        },
      };
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
