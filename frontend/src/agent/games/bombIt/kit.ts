import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  BombItProtocol,
  type BombItState,
  type BombItMove,
} from "sui-tunnel-ts/protocol/bombIt";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

/** Which seat acts on this tick: A on even ticks, B on odd — the protocol's signing attribution. */
function turnOf(tick: bigint): Party {
  return tick % 2n === 0n ? "A" : "B";
}

/** A bot that proposes a legal random action whenever it is this seat's tick, else waits. */
class BombItBot implements GameBot<BombItState, BombItMove> {
  private readonly seat: Party;
  private readonly protocol: BombItProtocol;
  private readonly rng: () => number;

  constructor(seat: Party, protocol: BombItProtocol, ctx: BotContext) {
    this.seat = seat;
    this.protocol = protocol;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: BombItState): BombItMove | null {
    if (this.protocol.isTerminal(state)) return null;
    if (turnOf(state.tick) !== this.seat) return null;
    return this.protocol.randomMove(state, this.seat, this.rng);
  }

  confirm(): void {
    // No retained memory — each move is decided purely from the current state.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createBombItKit(
  stake: bigint,
): GameKit<BombItState, BombItMove> {
  const protocol = new BombItProtocol();
  return {
    id: "bomb-it",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new BombItBot(seat, protocol, ctx),
    defaultStake: stake,
  };
}
