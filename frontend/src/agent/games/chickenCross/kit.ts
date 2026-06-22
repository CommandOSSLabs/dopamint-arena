import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  CrossProtocol,
  type CrossState,
  type CrossMove,
} from "sui-tunnel-ts/protocol/cross";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

/** Which seat signs this tick: A on even ticks, B on odd. One world tick advances both racers. */
function turnOf(tick: bigint): Party {
  return tick % 2n === 0n ? "A" : "B";
}

/** A bot that advances the race with a greedy random hop on its tick, else waits. */
class ChickenCrossBot implements GameBot<CrossState, CrossMove> {
  private readonly seat: Party;
  private readonly protocol: CrossProtocol;
  private readonly rng: () => number;

  constructor(seat: Party, protocol: CrossProtocol, ctx: BotContext) {
    this.seat = seat;
    this.protocol = protocol;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: CrossState): CrossMove | null {
    if (this.protocol.isTerminal(state)) return null;
    if (turnOf(state.tick) !== this.seat) return null;
    return this.protocol.randomMove(state, this.seat, this.rng);
  }

  confirm(): void {
    // No retained memory — each hop is decided purely from the current state.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createChickenCrossKit(stake: bigint): GameKit<CrossState, CrossMove> {
  const protocol = new CrossProtocol();
  return {
    id: "chicken-cross",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) => new ChickenCrossBot(seat, protocol, ctx),
    defaultStake: stake,
  };
}
