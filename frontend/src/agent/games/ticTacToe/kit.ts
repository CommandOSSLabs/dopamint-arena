import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { protocols } from "sui-tunnel-ts";
import {
  MultiGameTicTacToeProtocol,
  type MultiGameTicTacToeState,
  type MultiGameTicTacToeMove,
} from "@ttt/shared/ttt/multiGameProtocol";
import { optimalMoves } from "@ttt/shared/ttt/minimax";
import { CELL_EMPTY, CELL_SERVER, CELL_PLAYER } from "@ttt/shared/constants";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

export type TicTacToeDifficulty = "perfect" | "fast";

export interface TicTacToeBotConfig {
  difficulty?: TicTacToeDifficulty;
}

/** Deterministic FNV-1a fold of state bytes into [0, n), seeded per seat. */
function fastIndex(seed: number, bytes: Uint8Array, n: number): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  }
  return h % n;
}

function pickCell(
  state: protocols.TicTacToeState,
  seat: Party,
  difficulty: TicTacToeDifficulty,
  fastSeed: number,
  innerProtocol: protocols.TicTacToeProtocol,
): number {
  const empties = state.board
    .map((v, i) => (v === 0 ? i : -1))
    .filter((i) => i >= 0);
  if (empties.length === 0) return -1;

  if (difficulty === "fast") {
    // Pure function of (seat seed, state): idempotent on a replayed state, varies
    // per board. Must NOT consume a mutable RNG stream or plan() stops being pure.
    return empties[
      fastIndex(fastSeed, innerProtocol.encodeState(state), empties.length)
    ];
  }

  const mark = seat === "A" ? 1 : 2;
  const board = state.board.map((v) =>
    v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER,
  );
  const moves = optimalMoves(board, CELL_SERVER);
  return moves.length > 0 ? moves[0] : empties[0];
}

class TicTacToeBot implements GameBot<
  MultiGameTicTacToeState,
  MultiGameTicTacToeMove
> {
  private readonly seat: Party;
  private readonly difficulty: TicTacToeDifficulty;
  private readonly innerProtocol: protocols.TicTacToeProtocol;
  private readonly protocol: MultiGameTicTacToeProtocol;
  private readonly fastSeed: number;

  constructor(
    seat: Party,
    stake: bigint,
    ctx: BotContext,
    config: TicTacToeBotConfig,
    protocol: MultiGameTicTacToeProtocol,
  ) {
    this.seat = seat;
    this.difficulty = config.difficulty ?? "perfect";
    this.innerProtocol = new protocols.TicTacToeProtocol(stake);
    this.protocol = protocol;
    // Consume the per-seat RNG ONCE for a stable base seed; fast-mode picks are then
    // a pure function of (seed, state), keeping plan() idempotent on a replayed state.
    this.fastSeed = Math.floor(ctx.rngForSeat(seat)() * 0x1_0000_0000) >>> 0;
  }

  plan(state: MultiGameTicTacToeState): MultiGameTicTacToeMove | null {
    const inner = state.inner;

    if (this.innerProtocol.isTerminal(inner)) {
      // The inner game ended; seat A advances to the next game — but ONLY while the
      // whole session is still live. When the session is terminal (max games reached
      // OR a side can no longer fund the next stake) any advance move is illegal and
      // applyMove would reject it ("session over").
      if (!this.protocol.isTerminal(state) && this.seat === "A") {
        return { cell: 0 };
      }
      return null;
    }

    if (inner.turn !== this.seat) return null;
    return {
      cell: pickCell(
        inner,
        this.seat,
        this.difficulty,
        this.fastSeed,
        this.innerProtocol,
      ),
    };
  }

  confirm(
    _state: MultiGameTicTacToeState,
    _move: MultiGameTicTacToeMove,
  ): void {
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
    createBot: (seat: Party, ctx: BotContext) =>
      new TicTacToeBot(seat, stake, ctx, config, protocol),
    defaultStake: stake,
  };
}
