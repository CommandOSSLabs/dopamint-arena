import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  BlackjackProtocol,
  actorFor,
  getPlayerParty,
  type PlayerPartyFor,
  type BlackjackState,
  type BlackjackMove,
} from "sui-tunnel-ts/protocol/blackjack";
import { blackjackMoveCodec } from "sui-tunnel-ts/protocol/blackjackCodec";
import { defaultStateHash } from "@/agent/stateHash";
import { type BotContext, type GameBot, type GameKit } from "@/agent/gameKit";

/**
 * Commit-reveal blackjack bot. Plays only when `actorFor` (under the kit's seat assignment)
 * says this seat owes the move, then delegates to the protocol's `randomMove` — which mints a
 * commit secret, reveals from the stored local secret, bets MIN_BET, and uses basic strategy
 * (hit < 17) for the player turn.
 */
class BlackjackBot implements GameBot<BlackjackState, BlackjackMove> {
  private readonly seat: Party;
  private readonly protocol: BlackjackProtocol;
  private readonly playerPartyFor: PlayerPartyFor;
  private readonly rng: () => number;

  constructor(
    seat: Party,
    protocol: BlackjackProtocol,
    playerPartyFor: PlayerPartyFor,
    ctx: BotContext,
  ) {
    this.seat = seat;
    this.protocol = protocol;
    this.playerPartyFor = playerPartyFor;
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: BlackjackState): BlackjackMove | null {
    if (actorFor(state, this.playerPartyFor) !== this.seat) return null;
    return this.protocol.randomMove(state, this.seat, this.rng);
  }

  confirm(_state: BlackjackState, _move: BlackjackMove): void {}
  abort(): void {}
}

/**
 * `playerPartyFor` selects role→seat assignment: default 2-round rotation (PvP / fair self-play)
 * or `FIXED_PLAYER_A` to pin the human to seat A in single-player "vs bot". It is threaded into
 * BOTH the protocol and the bot so they agree on whose turn it is; it never affects the encoded
 * state (wire parity).
 */
export function createBlackjackKit(
  stake: bigint,
  playerPartyFor: PlayerPartyFor = getPlayerParty,
): GameKit<BlackjackState, BlackjackMove> {
  const protocol = new BlackjackProtocol(playerPartyFor);

  return {
    id: "blackjack",
    protocol,
    moveCodec: blackjackMoveCodec,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new BlackjackBot(seat, protocol, playerPartyFor, ctx),
    defaultStake: stake,
  };
}
