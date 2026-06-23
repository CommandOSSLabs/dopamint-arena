import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  TicTacToeProtocol,
  type TicTacToeState,
  type TicTacToeMove,
} from "sui-tunnel-ts/protocol/ticTacToe";
import {
  MultiGameTicTacToeProtocol,
  type MultiGameTicTacToeState,
  type MultiGameTicTacToeMove,
} from "@ttt/shared/ttt/multiGameProtocol";
import { optimalMoves } from "@ttt/shared/ttt/minimax";
import {
  CELL_EMPTY,
  CELL_SERVER,
  CELL_PLAYER,
} from "@ttt/shared/constants";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

export type TicTacToeDifficulty = "perfect" | "fast";

export interface TicTacToeBotConfig {
  difficulty?: TicTacToeDifficulty;
}

function pickCell(
  state: TicTacToeState,
  seat: Party,
  difficulty: TicTacToeDifficulty,
  rng: () => number,
): number {
  const empties = state.board
    .map((v, i) => (v === 0 ? i : -1))
    .filter((i) => i >= 0);
  if (empties.length === 0) return -1;

  if (difficulty === "fast") {
    return empties[Math.floor(rng() * empties.length)];
  }

  const mark = seat === "A" ? 1 : 2;
  const board = state.board.map((v) =>
    v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER,
  );
  const moves = optimalMoves(board, CELL_SERVER);
  return moves.length > 0 ? moves[0] : empties[0];
}

class TicTacToeBot implements GameBot<MultiGameTicTacToeState, MultiGameTicTacToeMove> {
  private readonly seat: Party;
  private readonly difficulty: TicTacToeDifficulty;
  private readonly innerProtocol: TicTacToeProtocol;
  private readonly rng: () => number;

  constructor(seat: Party, stake: bigint, ctx: BotContext, config: TicTacToeBotConfig) {
    this.seat = seat;
    this.difficulty = config.difficulty ?? "perfect";
    this.innerProtocol = new TicTacToeProtocol(stake);
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: MultiGameTicTacToeState): MultiGameTicTacToeMove | null {
    const inner = state.inner;

    if (this.innerProtocol.isTerminal(inner)) {
      if (state.gamesPlayed + 1 < state.maxGames && this.seat === "A") {
        return { cell: 0 };
      }
      return null;
    }

    if (inner.turn !== this.seat) return null;
    return { cell: pickCell(inner, this.seat, this.difficulty, this.rng) };
  }

  confirm(_state: MultiGameTicTacToeState, _move: MultiGameTicTacToeMove): void {
    // No retained memory.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createTicTacToeKit(
  maxGames: number,
  stake: bigint,
  config: TicTacToeBotConfig = {},
): GameKit<MultiGameTicTacToeState, MultiGameTicTacToeMove> {
  const protocol = new MultiGameTicTacToeProtocol(maxGames, stake);

  return {
    id: "tictactoe",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) => new TicTacToeBot(seat, stake, ctx, config),
    defaultStake: stake,
  };
}
