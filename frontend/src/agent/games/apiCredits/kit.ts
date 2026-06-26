import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  ApiCreditsProtocol,
  type ApiCreditsState,
  type ApiCreditsMove,
} from "sui-tunnel-ts/protocol/apiCredits";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

/**
 * A client agent that spends one credit per API call until its prepaid balance
 * can't cover another. Only seat A (the client) initiates; the provider seat B
 * never proposes a move. The move is JSON-native, so no codec is needed.
 */
class ApiCreditsBot implements GameBot<ApiCreditsState, ApiCreditsMove> {
  private readonly seat: Party;
  private readonly protocol: ApiCreditsProtocol;
  private readonly rng: () => number;

  constructor(seat: Party, protocol: ApiCreditsProtocol, ctx: BotContext) {
    this.seat = seat;
    this.protocol = protocol;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: ApiCreditsState): ApiCreditsMove | null {
    return this.protocol.randomMove(state, this.seat, this.rng);
  }

  confirm(): void {
    // No retained memory — each call is decided from the current state.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createApiCreditsKit(
  costPerCall: bigint,
  stake: bigint,
): GameKit<ApiCreditsState, ApiCreditsMove> {
  const protocol = new ApiCreditsProtocol(costPerCall);
  return {
    id: "api-credits",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new ApiCreditsBot(seat, protocol, ctx),
    defaultStake: stake,
  };
}
