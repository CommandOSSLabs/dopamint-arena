import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  BlackjackBetProtocol,
  fixedBetMove,
  getPlayerParty,
  BET_OPTIONS,
  MIN_BET,
  type PlayerPartyFor,
  type BetBlackjackState,
  type BetBlackjackMove,
} from "@/games/blackjack/app/lib/bjBetProtocol";
import { handValue } from "@/games/blackjack/app/lib/bjCards";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

class BlackjackBot implements GameBot<BetBlackjackState, BetBlackjackMove> {
  private readonly seat: Party;
  private readonly protocol: BlackjackBetProtocol;
  // The role→seat mapping this bot reasons with — MUST match the protocol's, or the bot would
  // judge "is it my turn" against a different rotation than the one applying its moves.
  private readonly playerPartyFor: PlayerPartyFor;

  constructor(
    seat: Party,
    protocol: BlackjackBetProtocol,
    playerPartyFor: PlayerPartyFor,
  ) {
    this.seat = seat;
    this.protocol = protocol;
    this.playerPartyFor = playerPartyFor;
  }

  private dealerPartyFor(round: bigint): Party {
    return this.playerPartyFor(round) === "A" ? "B" : "A";
  }

  plan(state: BetBlackjackState): BetBlackjackMove | null {
    if (this.protocol.isTerminal(state)) return null;
    if (this.protocol.actorFor(state) !== this.seat) return null;

    if (state.phase === "round_over") {
      const cap =
        state.balanceA < state.balanceB ? state.balanceA : state.balanceB;
      const options = BET_OPTIONS.filter(
        (o) => BigInt(o) >= MIN_BET && BigInt(o) <= cap,
      );
      const amount = options.length > 0 ? options[0] : Number(MIN_BET);
      return fixedBetMove(amount, state);
    }

    if (state.phase === "player") {
      if (this.seat !== this.playerPartyFor(state.round)) return null;
      return { action: handValue(state.playerHand) < 17 ? "hit" : "stand" };
    }

    if (state.phase === "dealer") {
      if (this.seat !== this.dealerPartyFor(state.round)) return null;
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

/**
 * `playerPartyFor` selects the role→seat assignment: the default 2-round rotation (PvP / fair
 * self-play settlement) or `FIXED_PLAYER_A` for the single-human "Play vs Bot" view, which pins
 * the player to seat A so the table never inverts. It's threaded into BOTH the protocol and the
 * bot so they agree on whose turn it is; it never affects the encoded state (wire/Move parity).
 */
export function createBlackjackKit(
  stake: bigint,
  playerPartyFor: PlayerPartyFor = getPlayerParty,
): GameKit<BetBlackjackState, BetBlackjackMove> {
  const protocol = new BlackjackBetProtocol(playerPartyFor);

  return {
    id: "blackjack",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, _ctx: BotContext) =>
      new BlackjackBot(seat, protocol, playerPartyFor),
    defaultStake: stake,
  };
}
