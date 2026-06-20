import type { Protocol, Party, ProtocolContext, Balances } from "sui-tunnel-ts/protocol/Protocol";

export type GameId = "tictactoe" | "blackjack" | "battleship" | "quantum-poker";
export type StateHash = string;

export interface BotContext {
  /** Per-seat, seeded, reproducible RNG stream. */
  rngForSeat(seat: Party): () => number;
}

export interface GameKit<S, M> {
  id: GameId;
  /** The real frontend protocol class the human `usePvp*` hook uses. */
  protocol: Protocol<S, M>;
  /** Stable state digest for idempotency checks. */
  stateHash(state: S): StateHash;
  createBot(seat: Party, ctx: BotContext): GameBot<S, M>;
  defaultStake: bigint;
}

export interface GameBot<S, M> {
  /** Purely decide this seat's next move. Null = not my turn / waiting on peer. */
  plan(state: S): M | null;
  /** Advance retained memory AFTER the move has been accepted by the protocol. */
  confirm(state: S, move: M): void;
  /** Teardown after an error or unclean close. */
  abort(): void;
}

export type GameKitRegistry = Record<GameId, GameKit<unknown, unknown>>;

/** To be populated in Task 7 after all kits exist. */
export const GAME_KITS: GameKitRegistry = {} as GameKitRegistry;

const HEX = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[b >>> 4] + HEX[b & 0x0f];
  }
  return out;
}

/** Default state hash: hex of protocol.encodeState. */
export function defaultStateHash<S, M>(protocol: Protocol<S, M>, state: S): StateHash {
  return bytesToHex(protocol.encodeState(state));
}
