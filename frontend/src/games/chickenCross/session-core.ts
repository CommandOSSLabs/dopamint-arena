/**
 * Pure driver for a bot-vs-bot Chicken Cross tunnel session. No React, no timers, no
 * Vite-only imports — only the SDK engine (erased types + the runtime-safe OffchainTunnel),
 * so it is trivially unit-tested under tsx. The React hook owns keypairs, the timer, the
 * on-chain open/close, and telemetry. CrossBoard.tsx (Vite-only) owns hazard rendering.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { CrossProtocol, CrossState, CrossMove } from "sui-tunnel-ts/protocol/cross";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";

/** Flat, render-friendly snapshot of a CrossState (bigints -> numbers). */
export interface CrossView {
  tick: number;
  /** Hazard-field seed (same value the protocol uses) so the board renders aligned hazards. */
  seed: number;
  players: { lane: number; col: number; score: number }[];
  winner: "A" | "B" | null;
  balanceA: number;
  balanceB: number;
}

/** Which bot won the race (or a push at the tick cap). */
export type SessionResult = "A" | "B" | "push";

/**
 * Advance the session by one world tick. Returns false when the race is terminal (the
 * caller then stops the timer and settles). `by` alternates only for signing attribution;
 * the protocol advances the whole world from the move's dirA/dirB.
 */
export function stepSession(
  protocol: CrossProtocol,
  tunnel: OffchainTunnel<CrossState, CrossMove>,
  rng: () => number,
): boolean {
  const state = tunnel.state;
  if (protocol.isTerminal(state)) return false;
  const by: Party = state.tick % 2n === 0n ? "A" : "B";
  const move = protocol.randomMove(state, by, rng);
  if (!move) return false;
  tunnel.step(move, by);
  return true;
}

export function deriveView(state: CrossState): CrossView {
  return {
    tick: Number(state.tick),
    seed: Number(state.seed),
    players: state.players.map((p) => ({ lane: p.lane, col: p.col, score: p.score })),
    winner: state.winner,
    balanceA: Number(state.balanceA),
    balanceB: Number(state.balanceB),
  };
}

export function sessionResult(state: CrossState): SessionResult {
  if (state.winner === "A") return "A";
  if (state.winner === "B") return "B";
  return "push";
}
