import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";
import { defaultStateHash } from "@/agent/stateHash";
import {
  BET_OPTIONS,
  BlackjackBetProtocol,
  commitMoveFromSecret,
  fixedBetMove,
  getPlayerParty,
  MIN_BET,
  revealMoveFromSecret,
  secureCommitSecret,
  type BetBlackjackMove,
  type BetBlackjackState,
  type PlayerPartyFor,
} from "@/games/blackjack/app/lib/bjBetProtocol";
import { handValue } from "@/games/blackjack/app/lib/bjCards";
import { bjMoveCodec } from "@/games/blackjack/app/lib/bjMoveCodec";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

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

  plan(state: BetBlackjackState): BetBlackjackMove | null {
    if (this.protocol.isTerminal(state)) return null;

    // Per-card commit-reveal "plumbing": both seats contribute, strictly serialized A-then-B.
    // Secrets are minted from the CSPRNG here; the relay codec drops the pre-image.
    if (state.phase === "draw_commit") {
      const owe = !state.pendingCommitA
        ? "A"
        : !state.pendingCommitB
          ? "B"
          : null;
      if (owe !== this.seat) return null;
      return commitMoveFromSecret(secureCommitSecret());
    }
    if (state.phase === "draw_reveal") {
      const owe = !state.pendingRevealA
        ? "A"
        : !state.pendingRevealB
          ? "B"
          : null;
      if (owe !== this.seat) return null;
      const secret =
        this.seat === "A" ? state.localSecretA : state.localSecretB;
      return secret ? revealMoveFromSecret(secret) : null;
    }

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
    // Strip the commit pre-image from relayed moves (agent-vs-agent over a tunnel).
    moveCodec: bjMoveCodec,
    defaultStake: stake,
  };
}
