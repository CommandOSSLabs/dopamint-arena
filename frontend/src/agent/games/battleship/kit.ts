import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { otherParty } from "sui-tunnel-ts/protocol/Protocol";
import {
  BattleshipProtocol,
  battleshipMoveCodec,
  type BattleshipState,
  type BattleshipMove,
} from "@/games/battleship/protocol/battleship";
import {
  BOT_CONFIGS,
  type BotDifficulty,
  DEFAULT_BOT_DIFFICULTY,
  pickShot,
} from "@/games/battleship/engine/bot";
import {
  randomFleetSecret,
  type FleetSecret,
} from "@/games/battleship/engine/selfPlay";
import { proveCell } from "@/games/battleship/engine/merkle";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

export interface BattleshipBotConfig {
  difficulty?: BotDifficulty;
  /**
   * Use this fleet instead of a fresh random one. Lets a caller own the fleet — e.g. a spectator
   * view that reveals both boards, or vs-bot where the bot must answer reveals for a human-placed
   * fleet. Omit for an autonomous bot that hides its own fleet.
   */
  secret?: FleetSecret;
}

class BattleshipBot implements GameBot<BattleshipState, BattleshipMove> {
  private readonly seat: Party;
  private readonly secret: FleetSecret;
  private readonly rng: () => number;
  private readonly difficulty: BotDifficulty;

  constructor(seat: Party, ctx: BotContext, config: BattleshipBotConfig) {
    this.seat = seat;
    this.rng = ctx.rngForSeat(seat);
    this.secret = config.secret ?? randomFleetSecret(this.rng);
    this.difficulty = config.difficulty ?? DEFAULT_BOT_DIFFICULTY;
  }

  plan(state: BattleshipState): BattleshipMove | null {
    if (state.phase === "over" || state.winner !== 0) return null;

    if (state.phase === "awaitingCommits") {
      if (!state.commitA && this.seat !== "A") return null;
      if (state.commitA && !state.commitB && this.seat !== "B") return null;
      const committed = this.seat === "A" ? state.commitA : state.commitB;
      if (committed !== null) return null;
      return { type: "commit", root: this.secret.commitment.root };
    }

    if (state.pendingShot) {
      if (otherParty(state.pendingShot.by) !== this.seat) return null;
      const cell = state.pendingShot.cell;
      return {
        type: "reveal",
        cell,
        isShip: this.secret.board[cell] === 1,
        salt: this.secret.salts[cell],
        proof: proveCell(this.secret.commitment, cell),
      };
    }

    if (state.turn !== this.seat) return null;
    return {
      type: "shoot",
      cell: pickShot(state, this.seat, this.rng, BOT_CONFIGS[this.difficulty]),
    };
  }

  confirm(_state: BattleshipState, _move: BattleshipMove): void {
    // Targeting state is derived from public state on each plan call.
  }

  abort(): void {
    // Memory is released when the instance is garbage-collected.
  }
}

export function createBattleshipKit(
  stake: bigint,
  config: BattleshipBotConfig = {},
): GameKit<BattleshipState, BattleshipMove> {
  const protocol = new BattleshipProtocol(stake);

  return {
    id: "battleship",
    protocol,
    moveCodec: battleshipMoveCodec,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new BattleshipBot(seat, ctx, config),
    defaultStake: stake,
  };
}
