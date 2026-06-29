/**
 * Battleship move codec for the relay, mirroring `blackjackCodec`. The frame
 * envelope is JSON, which cannot carry the binary fields (`commitment`, `board`,
 * `salt`) — those are hex-encoded here and restored on the far side. The secret
 * board only ever appears inside the terminal `reveal_board`.
 */
import { fromHex, toHex } from "../core/bytes";
import type { MoveCodec } from "../core/distributedFrame";
import type { BattleshipMove } from "./battleship";

const hex = (b: Uint8Array): string => "0x" + toHex(b);

export function battleshipMoveToJson(move: BattleshipMove): unknown {
  switch (move.kind) {
    case "commit":
      return { kind: "commit", commitment: hex(move.commitment) };
    case "shoot":
      return { kind: "shoot", cell: move.cell };
    case "answer":
      return move.next === undefined
        ? { kind: "answer", isHit: move.isHit }
        : { kind: "answer", isHit: move.isHit, next: move.next };
    case "reveal_board":
      return {
        kind: "reveal_board",
        board: hex(move.board),
        salt: hex(move.salt),
      };
    case "resign":
      return { kind: "resign" };
  }
}

export function battleshipMoveFromJson(value: unknown): BattleshipMove {
  const o = value as {
    kind: string;
    commitment?: string;
    cell?: number;
    isHit?: boolean;
    next?: number;
    board?: string;
    salt?: string;
  };
  switch (o.kind) {
    case "commit":
      return { kind: "commit", commitment: fromHex(o.commitment!) };
    case "shoot":
      return { kind: "shoot", cell: o.cell! };
    case "answer":
      return o.next === undefined
        ? { kind: "answer", isHit: o.isHit! }
        : { kind: "answer", isHit: o.isHit!, next: o.next };
    case "reveal_board":
      return {
        kind: "reveal_board",
        board: fromHex(o.board!),
        salt: fromHex(o.salt!),
      };
    case "resign":
      return { kind: "resign" };
    default:
      throw new Error(`unknown battleship move kind ${o.kind}`);
  }
}

export const battleshipMoveCodec: MoveCodec<BattleshipMove> = {
  encode: battleshipMoveToJson,
  decode: battleshipMoveFromJson,
};
