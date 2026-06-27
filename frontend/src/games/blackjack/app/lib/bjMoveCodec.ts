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
      case "commit": {
        const commitment = fromHex(o.commitment!);
        if (commitment.length !== 32)
          throw new Error("commit.commitment must be 32 bytes");
        return { action: "commit", commitment };
      }
      case "reveal":
        return {
          action: "reveal",
          reveal: {
            value: fromHex(o.reveal!.value!),
            salt: fromHex(o.reveal!.salt!),
          },
        };
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
