import type { Protocol, Party, ProtocolContext, Balances } from "sui-tunnel-ts/protocol/Protocol";
import { createTicTacToeKit } from "./games/ticTacToe/kit";
import { createBlackjackKit } from "./games/blackjack/kit";
import { createBattleshipKit } from "./games/battleship/kit";
import { createQuantumPokerKit } from "./games/quantumPoker/kit";
import { defaultStateHash, type StateHash } from "./stateHash";

export type GameId = "tictactoe" | "blackjack" | "battleship" | "quantum-poker";
export type { StateHash };
export { defaultStateHash };

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

/** Canonical registry of all playable bot kits. */
export const GAME_KITS: GameKitRegistry = {
  tictactoe: createTicTacToeKit(10, 10n),
  blackjack: createBlackjackKit(100n),
  battleship: createBattleshipKit(10n),
  "quantum-poker": createQuantumPokerKit(100n),
};
