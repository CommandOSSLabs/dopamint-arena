import { GAME_KITS, type GameKit, type GameId } from "../../../frontend/src/agent/gameKit";

/** Bench id -> canonical kit id. The bench drives the real FE protocol class. */
const GAME_TO_KIT: Record<string, GameId> = {
  ticTacToe: "tictactoe",
  blackjack: "blackjack",
  battleship: "battleship",
  quantumPoker: "quantum-poker",
  bombIt: "bomb-it",
  cross: "chicken-cross",
};

export const PLAYABLE = ["ticTacToe", "blackjack", "battleship", "quantumPoker", "bombIt", "cross"] as const;

export function isPlayable(game: string): boolean {
  return game in GAME_TO_KIT;
}

export function kitFor(game: string): GameKit<unknown, unknown> {
  const id = GAME_TO_KIT[game];
  if (!id) throw new Error(`game "${game}" has no kit (playable: ${PLAYABLE.join(", ")})`);
  return GAME_KITS[id];
}

/** Per-seat stake = the kit's default stake; balances are { a: stake, b: stake }. */
export function gameStake(game: string): bigint {
  return kitFor(game).defaultStake;
}
