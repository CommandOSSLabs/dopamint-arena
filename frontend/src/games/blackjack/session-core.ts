/**
 * Pure driver for a bot-vs-bot Blackjack tunnel session. No React, no timers — only the tiny
 * party-mapping helpers are runtime SDK imports; everything else is types (erased at build), so it
 * stays trivially unit-tested. The React hook (useBlackjackSession) owns keypairs, timer, telemetry.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type {
  BlackjackProtocol,
  BlackjackState,
  BlackjackMove,
  BlackjackPhase,
} from "sui-tunnel-ts/protocol/blackjack";
import {
  getPlayerParty,
  getDealerParty,
} from "sui-tunnel-ts/protocol/blackjack";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";

import { handValue, handToCardIndices } from "./cards.ts";

/** Whose turn it is, derived purely from the protocol phase and round. */
export function partyForPhase(phase: BlackjackPhase, round: bigint): Party {
  if (phase === "round_over") return getPlayerParty(round + 1n);
  return phase === "dealer" ? getDealerParty(round) : getPlayerParty(round);
}

/**
 * Advance the session by one bot move. Returns false when the game is terminal or
 * no legal move exists (the caller then stops the timer and settles).
 */
export function stepSession(
  protocol: BlackjackProtocol,
  tunnel: OffchainTunnel<BlackjackState, BlackjackMove>,
  rng: () => number,
): boolean {
  const state = tunnel.state;
  if (protocol.isTerminal(state)) return false;
  const by = partyForPhase(state.phase, state.round);
  const move = protocol.randomMove(state, by, rng);
  if (!move) return false;
  tunnel.step(move, by);
  return true;
}

/** Player-bankroll outcome relative to the starting stake. */
export type SessionResult = "win" | "lose" | "push";

export function sessionResult(
  state: BlackjackState,
  stake: bigint,
): SessionResult {
  if (state.balanceA > stake) return "win";
  if (state.balanceA < stake) return "lose";
  return "push";
}

/** Flat, render-friendly snapshot of a BlackjackState (bigints -> numbers, faces mapped). */
export interface BlackjackView {
  playerCards: number[]; // display indices 0..51 for CardDisplay
  dealerCards: number[];
  playerSum: number;
  dealerSum: number;
  playerCardCount: number;
  dealerCardCount: number;
  playerBalance: number;
  dealerBalance: number;
  round: number;
  phase: BlackjackPhase;
}

export function deriveView(state: BlackjackState): BlackjackView {
  const round = Number(state.round);
  return {
    playerCards: handToCardIndices(state.playerHand, round * 2),
    dealerCards: handToCardIndices(state.dealerHand, round * 2 + 1),
    playerSum: handValue(state.playerHand),
    dealerSum: handValue(state.dealerHand),
    playerCardCount: state.playerHand.length,
    dealerCardCount: state.dealerHand.length,
    playerBalance: Number(state.balanceA),
    dealerBalance: Number(state.balanceB),
    round,
    phase: state.phase,
  };
}
