/**
 * Variable-bet player-vs-dealer Blackjack (game-side; implements the SDK `Protocol`). Like the
 * SDK's `BlackjackProtocol` (deterministic dealerless card stream, soft-ace handValue, dealer
 * draws to 17) but the PLAYER chooses the bet at the start of each round instead of a fixed
 * wager. Party A = player (bets + hit/stand), party B = dealer (deterministic). The chosen bet
 * swaps loser→winner per round (clamped to the loser's balance), so balances always sum to the
 * locked total. Bets are denominated in the same units as the balances/chips.
 */
import { core, protocols } from "sui-tunnel-ts";
import { handValue } from "@/games/blackjack/app/lib/bjCards";

type Party = protocols.Party;
type Balances = protocols.Balances;
type ProtocolContext = protocols.ProtocolContext;

/** Maps a round to the seat that holds the PLAYER role that round. */
export type PlayerPartyFor = (round: bigint) => Party;

// Default rotation: swap the player seat every two rounds. PvP needs this so BOTH humans get
// turns playing (and betting) rather than one being a perpetual dealer. Self-play vs the bot
// pins the player to seat A instead (FIXED_PLAYER_A) — there is no second human to be fair to,
// and a stable seat keeps the player's chips/outcome from inverting as the role would swap.
export function getPlayerParty(round: bigint): Party {
  const r = Number(round) - 1;
  return Math.floor(r / 2) % 2 === 0 ? "A" : "B";
}
export function getDealerParty(round: bigint): Party {
  return getPlayerParty(round) === "A" ? "B" : "A";
}

/** Non-rotating assignment: seat A is always the player, seat B always the dealer. */
export const FIXED_PLAYER_A: PlayerPartyFor = () => "A";

// Whole-token chips (MTPS is 0-decimal; ADR-0015): smallest bet is 1, with denominations scaled to
// the 1,000-chip buy-in so a table plays many meaningful rounds.
export const MIN_BET = 1n;
/** Chip denominations offered as bet buttons (filtered to <= the table max each round). */
export const BET_OPTIONS = [1, 5, 25, 100] as const;
const DEALER_STANDS_AT = 17;
const BUST_AT = 21;
const ROUND_CAP = 100n;

export type BetPhase = "round_over" | "player" | "dealer"; // round_over doubles as the betting state
export interface BetBlackjackState {
  phase: BetPhase;
  round: bigint;
  drawIndex: bigint;
  playerHand: number[];
  dealerHand: number[];
  balanceA: bigint; // player
  balanceB: bigint; // dealer
  total: bigint;
  bet: bigint; // the current round's bet
}
export type BetBlackjackMove =
  | { action: "bet"; amount: number }
  | { action: "hit" }
  | { action: "stand" };

const DOMAIN = protocols.protocolDomain("blackjack.bet.v1");
const PHASE_CODE: Record<BetPhase, number> = {
  round_over: 0,
  player: 1,
  dealer: 2,
};

function drawRank(round: bigint, drawIndex: bigint): number {
  let digest = core.blake2b256(
    core.concatBytes([DOMAIN, core.u64ToBeBytes(round)]),
  );
  const idx = Number(drawIndex);
  const block = Math.floor(idx / 32);
  for (let b = 0; b < block; b++)
    digest = core.blake2b256(core.concatBytes([digest, core.u64ToBeBytes(b)]));
  return (digest[idx % 32] % 13) + 1;
}
function rankValue(rank: number): number {
  if (rank === 1) return 11;
  if (rank >= 11) return 10;
  return rank;
}
const isBust = (h: number[]) => handValue(h) > BUST_AT;

/** Largest bet both sides can cover this round. */
export function maxBet(s: BetBlackjackState): bigint {
  return s.balanceA < s.balanceB ? s.balanceA : s.balanceB;
}

/**
 * The party the protocol expects to act next, by phase. In `round_over` the NEXT round's
 * player places the bet, so the actor is `getPlayerParty(round + 1)` — not the current
 * round's player. A self-play driver MUST use this to pick whom to move as; passing a fixed
 * party makes `randomMove` return null the moment the designated player flips (A,A,B,B,…),
 * which a naive loop misreads as "game over".
 */
export function actorFor(
  s: BetBlackjackState,
  playerPartyFor: PlayerPartyFor = getPlayerParty,
): Party {
  const dealerPartyFor = (r: bigint): Party =>
    playerPartyFor(r) === "A" ? "B" : "A";
  if (s.phase === "player") return playerPartyFor(s.round);
  if (s.phase === "dealer") return dealerPartyFor(s.round);
  return playerPartyFor(s.round + 1n);
}

/**
 * A fixed-amount bet move for the betting (`round_over`) phase, clamped to
 * [MIN_BET, maxBet]. Returns null when the table can no longer fund the minimum bet (the
 * game is effectively terminal) or when called outside the betting phase.
 */
export function fixedBetMove(
  amount: number,
  s: BetBlackjackState,
): BetBlackjackMove | null {
  if (s.phase !== "round_over") return null;
  const cap = maxBet(s);
  if (cap < MIN_BET) return null;
  const amt = Math.max(
    Number(MIN_BET),
    Math.min(Math.floor(amount), Number(cap)),
  );
  return { action: "bet", amount: amt };
}

export class BlackjackBetProtocol implements protocols.Protocol<
  BetBlackjackState,
  BetBlackjackMove
> {
  readonly name = "blackjack.bet.v1";

  // How the player role maps to a seat each round. Defaults to the 2-round rotation; self-play
  // passes FIXED_PLAYER_A to keep the player on seat A. Affects who acts/bets and who wins —
  // never the encoded state, so the wire format and Move parity are unchanged.
  private readonly playerPartyFor: PlayerPartyFor;
  constructor(playerPartyFor: PlayerPartyFor = getPlayerParty) {
    this.playerPartyFor = playerPartyFor;
  }
  private dealerPartyFor(round: bigint): Party {
    return this.playerPartyFor(round) === "A" ? "B" : "A";
  }
  /** The seat the protocol expects to act next, honoring this instance's role assignment. */
  actorFor(s: BetBlackjackState): Party {
    return actorFor(s, this.playerPartyFor);
  }

  initialState(ctx: ProtocolContext): BetBlackjackState {
    return {
      phase: "round_over",
      round: 0n,
      drawIndex: 0n,
      playerHand: [],
      dealerHand: [],
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
      bet: 0n,
    };
  }

  applyMove(
    s: BetBlackjackState,
    move: BetBlackjackMove,
    by: Party,
  ): BetBlackjackState {
    if (s.phase === "round_over") {
      if (move.action !== "bet")
        throw new Error("place a bet to start the round");
      const nextPlayer = this.playerPartyFor(s.round + 1n);
      if (by !== nextPlayer)
        throw new Error(`only the player (${nextPlayer}) sets the bet`);
      if (this.isTerminal(s))
        throw new Error("game over: a side cannot fund another bet");
      const amount = BigInt(Math.floor(move.amount));
      const cap = maxBet(s);
      if (amount < MIN_BET || amount > cap)
        throw new Error(`bet must be ${MIN_BET}..${cap}`);
      return dealRound(s, amount);
    }
    if (s.phase === "player") {
      const playerParty = this.playerPartyFor(s.round);
      if (by !== playerParty)
        throw new Error(`it is the player's (${playerParty}) turn`);
      if (move.action === "hit") {
        const { hand, drawIndex } = drawTo(s.playerHand, s.round, s.drawIndex);
        const next: BetBlackjackState = { ...s, playerHand: hand, drawIndex };
        return isBust(hand) ? settle(next, this.dealerPartyFor(s.round)) : next;
      }
      if (move.action === "stand") return { ...s, phase: "dealer" };
      throw new Error("invalid player action");
    }
    if (s.phase === "dealer") {
      const dealerParty = this.dealerPartyFor(s.round);
      if (by !== dealerParty)
        throw new Error(`it is the dealer's (${dealerParty}) turn`);
      if (move.action !== "stand")
        throw new Error("the dealer only stands (auto-play)");
      return resolveDealer(s, this.playerPartyFor);
    }
    throw new Error(`unexpected phase: ${String(s.phase)}`);
  }

  encodeState(s: BetBlackjackState): Uint8Array {
    return core.concatBytes([
      DOMAIN,
      core.u64ToBeBytes(s.balanceA),
      core.u64ToBeBytes(s.balanceB),
      core.u64ToBeBytes(s.round),
      core.u64ToBeBytes(s.drawIndex),
      new Uint8Array([PHASE_CODE[s.phase]]),
      core.u64ToBeBytes(s.bet),
      core.u64ToBeBytes(s.playerHand.length),
      Uint8Array.from(s.playerHand),
      core.u64ToBeBytes(s.dealerHand.length),
      Uint8Array.from(s.dealerHand),
    ]);
  }

  balances(s: BetBlackjackState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: BetBlackjackState): boolean {
    return (
      s.round >= ROUND_CAP || (s.phase === "round_over" && maxBet(s) < MIN_BET)
    );
  }

  randomMove(
    s: BetBlackjackState,
    by: Party,
    _rng: () => number,
  ): BetBlackjackMove | null {
    if (this.isTerminal(s)) return null;
    if (s.phase === "round_over") {
      if (by !== this.playerPartyFor(s.round + 1n)) return null;
      const cap = Number(maxBet(s));
      return {
        action: "bet",
        amount: Math.max(Number(MIN_BET), Math.min(100, cap)),
      };
    }
    if (s.phase === "player") {
      if (by !== this.playerPartyFor(s.round)) return null;
      return {
        action: handValue(s.playerHand) < DEALER_STANDS_AT ? "hit" : "stand",
      };
    }
    if (s.phase === "dealer")
      return by === this.dealerPartyFor(s.round) ? { action: "stand" } : null;
    return null;
  }
}

function drawTo(
  hand: number[],
  round: bigint,
  drawIndex: bigint,
): { hand: number[]; drawIndex: bigint } {
  return {
    hand: [...hand, rankValue(drawRank(round, drawIndex))],
    drawIndex: drawIndex + 1n,
  };
}
function dealRound(s: BetBlackjackState, bet: bigint): BetBlackjackState {
  const round = s.round + 1n;
  let drawIndex = 0n;
  let playerHand: number[] = [];
  let dealerHand: number[] = [];
  for (let i = 0; i < 2; i++) {
    const p = drawTo(playerHand, round, drawIndex);
    playerHand = p.hand;
    drawIndex = p.drawIndex;
  }
  for (let i = 0; i < 2; i++) {
    const d = drawTo(dealerHand, round, drawIndex);
    dealerHand = d.hand;
    drawIndex = d.drawIndex;
  }
  return {
    ...s,
    phase: "player",
    round,
    drawIndex,
    playerHand,
    dealerHand,
    bet,
  };
}
function resolveDealer(
  s: BetBlackjackState,
  playerPartyFor: PlayerPartyFor,
): BetBlackjackState {
  let hand = s.dealerHand;
  let drawIndex = s.drawIndex;
  while (handValue(hand) < DEALER_STANDS_AT) {
    const d = drawTo(hand, s.round, drawIndex);
    hand = d.hand;
    drawIndex = d.drawIndex;
  }
  const resolved: BetBlackjackState = { ...s, dealerHand: hand, drawIndex };
  const pv = handValue(resolved.playerHand);
  const dv = handValue(resolved.dealerHand);
  const playerParty = playerPartyFor(s.round);
  const dealerParty: Party = playerParty === "A" ? "B" : "A";
  const winner: Party | null = isBust(resolved.dealerHand)
    ? playerParty
    : pv > dv
      ? playerParty
      : dv > pv
        ? dealerParty
        : null;
  return settle(resolved, winner);
}
function settle(s: BetBlackjackState, winner: Party | null): BetBlackjackState {
  let balanceA = s.balanceA;
  let balanceB = s.balanceB;
  if (winner === "A") {
    const amt = s.bet <= balanceB ? s.bet : balanceB;
    balanceA += amt;
    balanceB -= amt;
  } else if (winner === "B") {
    const amt = s.bet <= balanceA ? s.bet : balanceA;
    balanceB += amt;
    balanceA -= amt;
  }
  return { ...s, phase: "round_over", balanceA, balanceB };
}
