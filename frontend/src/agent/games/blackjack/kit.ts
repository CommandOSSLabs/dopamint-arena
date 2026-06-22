import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  BlackjackBetProtocol,
  actorFor,
  fixedBetMove,
  getPlayerParty,
  getDealerParty,
  BET_OPTIONS,
  MIN_BET,
  type BetBlackjackState,
  type BetBlackjackMove,
} from "@/games/blackjack/app/lib/bjBetProtocol";
import { handValue } from "@/games/blackjack/app/lib/bjCards";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

class BlackjackBot implements GameBot<BetBlackjackState, BetBlackjackMove> {
  private readonly seat: Party;
  private readonly protocol: BlackjackBetProtocol;

  constructor(seat: Party, protocol: BlackjackBetProtocol) {
    this.seat = seat;
    this.protocol = protocol;
  }

  plan(state: BetBlackjackState): BetBlackjackMove | null {
    if (this.protocol.isTerminal(state)) return null;
    if (actorFor(state) !== this.seat) return null;

    if (state.phase === "round_over") {
      const cap = state.balanceA < state.balanceB ? state.balanceA : state.balanceB;
      const options = BET_OPTIONS.filter((o) => BigInt(o) >= MIN_BET && BigInt(o) <= cap);
      const amount = options.length > 0 ? options[0] : Number(MIN_BET);
      return fixedBetMove(amount, state);
    }

    if (state.phase === "player") {
      if (this.seat !== getPlayerParty(state.round)) return null;
      return { action: handValue(state.playerHand) < 17 ? "hit" : "stand" };
    }

    if (state.phase === "dealer") {
      if (this.seat !== getDealerParty(state.round)) return null;
      return { action: "stand" };
    }

    return null;
  }

  confirm(_state: BetBlackjackState, _move: BetBlackjackMove): void {
    // No retained memory beyond the public state.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createBlackjackKit(stake: bigint): GameKit<BetBlackjackState, BetBlackjackMove> {
  const protocol = new BlackjackBetProtocol();

  return {
    id: "blackjack",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, _ctx: BotContext) => new BlackjackBot(seat, protocol),
    defaultStake: stake,
  };
}
