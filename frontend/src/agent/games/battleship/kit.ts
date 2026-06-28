import { otherParty, type Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  BattleshipProtocol,
  type BattleshipState,
  type BattleshipMove,
} from "sui-tunnel-ts/protocol/battleship";
import { battleshipMoveCodec } from "sui-tunnel-ts/protocol/battleshipCodec";
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
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

export interface BattleshipBotConfig {
  difficulty?: BotDifficulty;
  /** Use this fleet instead of a fresh random one (spectator / human-fleet bot). */
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
    if (state.phase === "over") return null;

    if (state.phase === "awaitingCommits") {
      if (!state.commitA && this.seat !== "A") return null;
      if (state.commitA && !state.commitB && this.seat !== "B") return null;
      const committed = this.seat === "A" ? state.commitA : state.commitB;
      if (committed !== null) return null;
      return { kind: "commit", commitment: this.secret.commitment };
    }

    if (state.phase === "revealBoards") {
      const revealed = this.seat === "A" ? state.revealedA : state.revealedB;
      if (revealed) return null;
      return {
        kind: "reveal_board",
        board: this.secret.board,
        salt: this.secret.salt,
      };
    }

    // phase === "playing"
    if (state.pendingShot) {
      if (otherParty(state.pendingShot.by) !== this.seat) return null;
      const isHit = this.secret.board[state.pendingShot.cell] === 1;
      if (isHit) return { kind: "answer", isHit: true };
      // Miss: this seat takes the turn. Pipeline the return shot for bench TPS.
      // pickShot always returns an unfired cell (see its JSDoc), so no fired-set guard needed.
      const next = pickShot(
        state,
        this.seat,
        this.rng,
        BOT_CONFIGS[this.difficulty],
      );
      return { kind: "answer", isHit: false, next };
    }

    if (state.turn !== this.seat) return null;
    return {
      kind: "shoot",
      cell: pickShot(state, this.seat, this.rng, BOT_CONFIGS[this.difficulty]),
    };
  }

  confirm(_state: BattleshipState, _move: BattleshipMove): void {}
  abort(): void {}
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
