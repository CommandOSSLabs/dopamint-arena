import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  MultiGameCrossProtocol,
  type MultiGameCrossState,
  type MultiGameCrossMove,
} from "sui-tunnel-ts/protocol/multiGameCross";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

/** Which seat signs this inner tick: A on even ticks, B on odd. One world tick advances both racers. */
function turnOf(tick: bigint): Party {
  return tick % 2n === 0n ? "A" : "B";
}

/**
 * Multi-game-aware chicken-cross bot. Within a race it advances with a greedy random hop on its
 * tick; once a race is decided it — as seat A — emits the kickoff move (`{dirA:undefined}`) to
 * start the next race, while the session can still fund another. Mirrors ttt's multi-game bot so
 * the in-game solo loop and the agent harness share ONE move source (the kit).
 */
class ChickenCrossBot
  implements GameBot<MultiGameCrossState, MultiGameCrossMove>
{
  private readonly seat: Party;
  private readonly protocol: MultiGameCrossProtocol;
  private readonly rng: () => number;

  constructor(
    seat: Party,
    protocol: MultiGameCrossProtocol,
    ctx: BotContext,
  ) {
    this.seat = seat;
    this.protocol = protocol;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: MultiGameCrossState): MultiGameCrossMove | null {
    if (this.protocol.isGameOver(state)) {
      // Inner race decided; seat A kicks off the next race — but ONLY while the whole
      // session is still live (max games / both sides can still fund the next stake).
      if (!this.protocol.isTerminal(state) && this.seat === "A") {
        return { dirA: undefined };
      }
      return null;
    }
    if (turnOf(state.inner.tick) !== this.seat) return null;
    return this.protocol.randomMove(state, this.seat, this.rng);
  }

  confirm(): void {
    // No retained memory — each hop is decided purely from the current state.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createChickenCrossKit(
  stake: bigint,
): GameKit<MultiGameCrossState, MultiGameCrossMove> {
  // Each race's lanes are seeded from the RUNNING tunnel's real id (`${tunnelId}:g${N}`), supplied
  // by the live solo/PvP tunnel. The kit's bot only READS given states — isGameOver / isTerminal /
  // randomMove are all seed-independent — so a blank tunnel id here is correct; the bot never
  // generates a course.
  const protocol = new MultiGameCrossProtocol("", stake);
  return {
    id: "chicken-cross",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new ChickenCrossBot(seat, protocol, ctx),
    defaultStake: stake,
  };
}
