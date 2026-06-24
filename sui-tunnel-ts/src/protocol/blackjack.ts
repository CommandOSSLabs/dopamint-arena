/**
 * Blackjack protocol: a simplified TWO-PARTY, dealerless Blackjack over a tunnel.
 *
 * Party A is the "player", Party B is the "dealer" — but neither side controls the
 * cards. Every card is drawn from a DETERMINISTIC stream derived from a per-round
 * seed, so both parties (and an on-chain disputer replaying encodeState) agree on
 * exactly which cards came out. This keeps the game dealerless and bias-free without
 * any commit-reveal round-trips: the seed is a pure function of (tunnelId, round).
 *
 * ===== EXACT RULES (internally consistent; perfect casino fidelity not required) =====
 *
 *  Wager: a fixed WAGER (100n) is staked each round. A round can only start while
 *  BOTH parties can cover the wager (balance >= WAGER each); otherwise the game is
 *  terminal. The game is also terminal after ROUND_CAP rounds.
 *
 *  Card stream (deterministic, dealerless):
 *    seed_0 = blake2b256(DOMAIN || u64be(round))                    -- per-round seed
 *    Each draw consumes one byte of the current digest; when a digest's 32 bytes are
 *    exhausted we advance it via rollingDigest(blake2b256, digest, [drawIndex]).
 *    rank = (byte % 13) + 1, then card value:
 *      rank 1        -> Ace, counted as 11 (soft), reduced to 1 if the hand busts
 *      rank 11/12/13 -> 10 (J/Q/K)
 *      rank 2..10    -> face value
 *    Hand value = sum of card values, with each Ace independently downgraded 11->1
 *    while the total exceeds 21 (standard soft-ace handling). Bust = value > 21.
 *
 *  Initial deal: when a round begins, the player draws 2 cards and the dealer draws 2.
 *
 *  Turn structure (phase):
 *    'player'    : only A may move. 'hit' draws one card for the player. If the player
 *                  busts (value > 21) the round resolves immediately as a player loss.
 *                  'stand' ends the player's turn and begins the dealer's.
 *    'dealer'    : only B may move, and the only legal action is 'stand', which triggers
 *                  the dealer's deterministic auto-play: the dealer draws until its hand
 *                  value is >= 17 (or it busts), then the round is settled. (A 'hit' here
 *                  is illegal — the dealer does not take discretionary cards.)
 *    'round_over': either party may move; ANY action (hit or stand) deals a fresh round
 *                  (advancing `round`) provided the game is not terminal. If the game is
 *                  terminal, any move throws (nothing left to play).
 *
 *  Settlement (after a round resolves): compare final hand values.
 *    - player busts                       -> dealer (B) wins the wager
 *    - dealer busts (player did not)      -> player (A) wins the wager
 *    - player value > dealer value        -> player wins
 *    - dealer value > player value        -> dealer wins
 *    - equal                              -> push (no transfer)
 *  The winner gains WAGER from the loser. Transfers are clamped to the loser's balance
 *  (they can always cover it because a round only starts when both have >= WAGER), so
 *  balances NEVER go negative and ALWAYS sum to the locked total.
 *
 *  Balance conservation: money only ever moves between A and B (a +WAGER / -WAGER swap
 *  or a no-op push), so balances(state).a + balances(state).b == initial total for
 *  every reachable state.
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import { blake2b256 } from "../core/crypto";

/** Helper to determine who is the Player based on the round. */
export function getPlayerParty(round: bigint): Party {
  const r = Number(round) - 1;
  return Math.floor(r / 2) % 2 === 0 ? "A" : "B";
}

/** Helper to determine who is the Dealer based on the round. */
export function getDealerParty(round: bigint): Party {
  return getPlayerParty(round) === "A" ? "B" : "A";
}

/** Fixed stake per round. */
export const WAGER = 100n;
/** Max rounds before the game is forced terminal. */
export const ROUND_CAP = 1000n;
/** Dealer draws until reaching at least this hand value. */
const DEALER_STANDS_AT = 17;
/** Blackjack bust threshold. */
const BUST_AT = 21;

export type BlackjackPhase = "player" | "dealer" | "round_over";

export interface BlackjackState {
  phase: BlackjackPhase;
  /** 0-based round counter; also seeds the card stream. */
  round: bigint;
  /** Number of cards drawn so far this round (advances the card stream). */
  drawIndex: bigint;
  /** Card values held by the player (A). */
  playerHand: number[];
  /** Card values held by the dealer (B). */
  dealerHand: number[];
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  wager: bigint;
}

export interface BlackjackMove {
  action: "hit" | "stand";
}

const DOMAIN = protocolDomain("blackjack.v1");

const PHASE_CODE: Record<BlackjackPhase, number> = {
  player: 0,
  dealer: 1,
  round_over: 2,
};

/**
 * Deterministic card stream for a round. `seed = blake2b256(DOMAIN || round)`; each
 * draw consumes one byte, advancing to a fresh digest every 32 bytes via the rolling
 * digest so the stream is effectively unbounded yet reproducible.
 */
function drawRank(round: bigint, drawIndex: bigint): number {
  let digest = blake2b256(concatBytes([DOMAIN, u64ToBeBytes(round)]));
  const idx = Number(drawIndex);
  const block = Math.floor(idx / 32);
  // Advance to the digest block this draw lives in (32 draws per block).
  for (let b = 0; b < block; b++) {
    digest = blake2b256(concatBytes([digest, u64ToBeBytes(b)]));
  }
  const byte = digest[idx % 32];
  return (byte % 13) + 1;
}

/** Map a rank (1..13) to its raw blackjack value (Ace = 11 here; reduced later). */
function rankValue(rank: number): number {
  if (rank === 1) return 11; // Ace, high
  if (rank >= 11) return 10; // J / Q / K
  return rank;
}

/** Hand total with soft-ace handling: downgrade 11->1 per ace while busting. */
function handValue(hand: number[]): number {
  let total = 0;
  let aces = 0;
  for (const v of hand) {
    total += v;
    if (v === 11) aces++;
  }
  while (total > BUST_AT && aces > 0) {
    total -= 10; // count one ace as 1 instead of 11
    aces--;
  }
  return total;
}

function isBust(hand: number[]): boolean {
  return handValue(hand) > BUST_AT;
}

export class BlackjackProtocol implements Protocol<
  BlackjackState,
  BlackjackMove
> {
  readonly name = "blackjack.v1";

  initialState(ctx: ProtocolContext): BlackjackState {
    const base: BlackjackState = {
      phase: "round_over",
      round: 0n,
      drawIndex: 0n,
      playerHand: [],
      dealerHand: [],
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
      wager: WAGER,
    };
    // If both parties can afford the wager, deal the opening round; otherwise the
    // game starts already terminal (an empty round_over with no playable round).
    if (canStartRound(base)) return dealRound(base);
    return base;
  }

  applyMove(
    state: BlackjackState,
    move: BlackjackMove,
    by: Party,
  ): BlackjackState {
    if (move.action !== "hit" && move.action !== "stand") {
      throw new Error(`unknown action: ${String(move.action)}`);
    }

    if (state.phase === "round_over") {
      // Any move deals a new round, provided the game is not terminal.
      if (this.isTerminal(state)) {
        throw new Error("game over: no more rounds can be played");
      }
      return dealRound(state);
    }

    if (state.phase === "player") {
      const playerParty = getPlayerParty(state.round);
      if (by !== playerParty)
        throw new Error(`it is the player's (${playerParty}) turn`);
      if (move.action === "hit") {
        const { hand, drawIndex } = drawTo(
          state.playerHand,
          state.round,
          state.drawIndex,
        );
        const next: BlackjackState = {
          ...state,
          playerHand: hand,
          drawIndex,
        };
        if (isBust(hand)) {
          // Player busts -> dealer wins immediately, round resolves.
          return settle(next, getDealerParty(state.round));
        }
        return next;
      }
      // 'stand' -> dealer's turn begins.
      return { ...state, phase: "dealer" };
    }

    if (state.phase === "dealer") {
      const dealerParty = getDealerParty(state.round);
      if (by !== dealerParty)
        throw new Error(`it is the dealer's (${dealerParty}) turn`);
      if (move.action !== "stand") {
        throw new Error("dealer may only 'stand' (auto-play is deterministic)");
      }
      return resolveDealer(state);
    }

    // Unreachable given the phase union, but keep the function total.
    throw new Error(`unexpected phase: ${String(state.phase)}`);
  }

  encodeState(s: BlackjackState): Uint8Array {
    return concatBytes([
      DOMAIN,
      u64ToBeBytes(s.balanceA),
      u64ToBeBytes(s.balanceB),
      u64ToBeBytes(s.round),
      u64ToBeBytes(s.drawIndex),
      new Uint8Array([PHASE_CODE[s.phase]]),
      // Length-prefix each hand so two different states can't collide.
      u64ToBeBytes(s.playerHand.length),
      Uint8Array.from(s.playerHand),
      u64ToBeBytes(s.dealerHand.length),
      Uint8Array.from(s.dealerHand),
    ]);
  }

  balances(s: BlackjackState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: BlackjackState): boolean {
    if (s.round >= ROUND_CAP) return true;
    // Terminal only when the table is settled and a fresh round can't be funded.
    return s.phase === "round_over" && !canStartRound(s);
  }

  randomMove(
    s: BlackjackState,
    by: Party,
    rng: () => number,
  ): BlackjackMove | null {
    if (this.isTerminal(s)) return null;

    if (s.phase === "round_over") {
      // Both parties may start a new round; let the next Player do it to keep play moving.
      const nextPlayer = getPlayerParty(s.round + 1n);
      if (by !== nextPlayer) return null;
      return { action: rng() < 0.5 ? "hit" : "stand" };
    }

    if (s.phase === "player") {
      if (by !== getPlayerParty(s.round)) return null;
      // Basic strategy: hit while soft total < 17, else stand.
      return { action: handValue(s.playerHand) < 17 ? "hit" : "stand" };
    }

    if (s.phase === "dealer") {
      if (by !== getDealerParty(s.round)) return null;
      return { action: "stand" }; // only legal dealer action
    }

    return null;
  }
}

// ============================================
// INTERNAL HELPERS (pure)
// ============================================

/** True iff both parties can each cover the wager (so a round can begin). */
function canStartRound(s: BlackjackState): boolean {
  return s.balanceA >= s.wager && s.balanceB >= s.wager;
}

/** Draw one card onto `hand`, returning the new hand and advanced draw index. */
function drawTo(
  hand: number[],
  round: bigint,
  drawIndex: bigint,
): { hand: number[]; drawIndex: bigint } {
  const value = rankValue(drawRank(round, drawIndex));
  return { hand: [...hand, value], drawIndex: drawIndex + 1n };
}

/**
 * Deal a fresh round: increment the round, reset the card stream, deal 2 cards to
 * the player and 2 to the dealer, and put the table in 'player' phase. Assumes the
 * caller has verified a round can be funded (canStartRound).
 */
function dealRound(s: BlackjackState): BlackjackState {
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
  };
}

/** Dealer auto-play: draw to >= DEALER_STANDS_AT, then settle the round. */
function resolveDealer(s: BlackjackState): BlackjackState {
  let hand = s.dealerHand;
  let drawIndex = s.drawIndex;
  while (handValue(hand) < DEALER_STANDS_AT) {
    const d = drawTo(hand, s.round, drawIndex);
    hand = d.hand;
    drawIndex = d.drawIndex;
  }
  const resolved: BlackjackState = { ...s, dealerHand: hand, drawIndex };
  const playerValue = handValue(resolved.playerHand);
  const dealerValue = handValue(resolved.dealerHand);
  let winner: Party | null;
  if (isBust(resolved.dealerHand)) {
    winner = getPlayerParty(s.round); // player did not bust (that path resolves earlier), dealer busts
  } else if (playerValue > dealerValue) {
    winner = getPlayerParty(s.round);
  } else if (dealerValue > playerValue) {
    winner = getDealerParty(s.round);
  } else {
    winner = null; // push
  }
  return settle(resolved, winner);
}

/**
 * Settle the current round to `winner` (null = push) and move to 'round_over'.
 * The wager swap is clamped to the loser's balance, so balances never go negative
 * and always sum to the total.
 */
function settle(s: BlackjackState, winner: Party | null): BlackjackState {
  let balanceA = s.balanceA;
  let balanceB = s.balanceB;
  if (winner === "A") {
    const amt = s.wager <= balanceB ? s.wager : balanceB;
    balanceA += amt;
    balanceB -= amt;
  } else if (winner === "B") {
    const amt = s.wager <= balanceA ? s.wager : balanceA;
    balanceB += amt;
    balanceA -= amt;
  }
  return { ...s, phase: "round_over", balanceA, balanceB };
}
