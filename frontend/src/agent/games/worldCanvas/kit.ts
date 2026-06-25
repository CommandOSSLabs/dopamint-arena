import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  WorldCanvasProtocol,
  type WorldCanvasState,
  type WorldCanvasMove,
} from "sui-tunnel-ts/protocol/worldCanvas";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

/**
 * A bot that paints a random cell whenever it can. World Canvas is free /
 * collaborative mode — there are no turns, so either painter may act on any
 * state; the bot only stops at the (astronomical) placement cap.
 */
class WorldCanvasBot implements GameBot<WorldCanvasState, WorldCanvasMove> {
  private readonly seat: Party;
  private readonly protocol: WorldCanvasProtocol;
  private readonly rng: () => number;

  constructor(seat: Party, protocol: WorldCanvasProtocol, ctx: BotContext) {
    this.seat = seat;
    this.protocol = protocol;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: WorldCanvasState): WorldCanvasMove | null {
    if (this.protocol.isTerminal(state)) return null;
    return this.protocol.randomMove(state, this.seat, this.rng);
  }

  confirm(): void {
    // No retained memory — each paint is decided purely from the current state.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createWorldCanvasKit(
  stake: bigint,
): GameKit<WorldCanvasState, WorldCanvasMove> {
  const protocol = new WorldCanvasProtocol();
  return {
    id: "world-canvas",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new WorldCanvasBot(seat, protocol, ctx),
    defaultStake: stake,
  };
}
