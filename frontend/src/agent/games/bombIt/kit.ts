import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  MultiGameBombItProtocol,
  type MultiGameBombItState,
  type MultiGameBombItMove,
} from "sui-tunnel-ts/protocol/multiGameBombIt";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

/** Which seat acts on this inner tick: A on even ticks, B on odd — the protocol's signing attribution. */
function turnOf(tick: bigint): Party {
  return tick % 2n === 0n ? "A" : "B";
}

/**
 * Multi-game-aware bomb-it bot. Within a duel it proposes a legal random action on its tick;
 * once a duel is decided it — as seat A — emits the kickoff move (`{a:"stay"}`) to start the
 * next duel, while the whole session can still fund another. Mirrors ttt's multi-game bot so the
 * in-game solo loop and the agent harness share ONE move source (the kit).
 */
class BombItBot implements GameBot<MultiGameBombItState, MultiGameBombItMove> {
  private readonly seat: Party;
  private readonly protocol: MultiGameBombItProtocol;
  private readonly rng: () => number;

  constructor(seat: Party, protocol: MultiGameBombItProtocol, ctx: BotContext) {
    this.seat = seat;
    this.protocol = protocol;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: MultiGameBombItState): MultiGameBombItMove | null {
    if (this.protocol.isGameOver(state)) {
      // Inner duel decided; seat A kicks off the next duel — but ONLY while the whole
      // session is still live (max games / both sides can still fund the next stake).
      if (!this.protocol.isTerminal(state) && this.seat === "A") {
        return { a: "stay" };
      }
      return null;
    }
    if (turnOf(state.inner.tick) !== this.seat) return null;
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
): GameKit<MultiGameBombItState, MultiGameBombItMove> {
  // Each duel's grid is seeded from the RUNNING tunnel's real id (`${tunnelId}:g${N}`), supplied
  // by the live solo/PvP tunnel. The kit's bot only READS given states — isGameOver / isTerminal /
  // randomMove are all seed-independent — so a blank tunnel id here is correct; the bot never
  // generates a board.
  const protocol = new MultiGameBombItProtocol("", stake);
  return {
    id: "bomb-it",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new BombItBot(seat, protocol, ctx),
    defaultStake: stake,
  };
}
