/**
 * Pure driver for a bot-vs-bot Chicken Cross tunnel session. No React, no timers, no
 * Vite-only imports — only the SDK engine (erased types + the runtime-safe OffchainTunnel),
 * so it is trivially unit-tested under tsx. The React hook owns keypairs, the timer, the
 * on-chain open/close, and telemetry. CrossBoard.tsx (Vite-only) owns hazard rendering.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { CrossProtocol, CrossState, CrossMove, CrossDir } from "sui-tunnel-ts/protocol/cross";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";

/** When the human takes over a seat (auto mode off), the loop supplies its hop direction for that
 *  seat each tick; the other seat (and both while auto is on) is driven by the protocol's bot. */
export interface HumanSeat {
  seat: Party;
  getDir: () => CrossDir;
}

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
 * Advance the session by one world tick. Returns false when the race is terminal (the caller
 * then stops the timer and settles). One co-signed update is one seat's hop, chosen by tick
 * parity; the other chicken implicitly stays (but is still death-checked) — the 2-party model.
 */
export function stepSession(
  protocol: CrossProtocol,
  tunnel: OffchainTunnel<CrossState, CrossMove>,
  rng: () => number,
  human?: HumanSeat | null,
): boolean {
  const state = tunnel.state;
  if (protocol.isTerminal(state)) return false;
  const by: Party = state.tick % 2n === 0n ? "A" : "B";
  // One co-signed update is one seat's hop (the other implicitly stays), per the 2-party tunnel
  // model. When the human owns the acting seat this tick its hop comes from the player; otherwise
  // the bot proposes it. Each chicken therefore hops on its own parity ticks (like bomb-it).
  let move: CrossMove | null;
  if (human && human.seat === by) {
    const dir = human.getDir();
    move = by === "A" ? { dirA: dir } : { dirB: dir };
  } else {
    move = protocol.randomMove(state, by, rng);
  }
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

/**
 * The lane window the board renders (top = forward). Anchors on YOUR chicken so the camera
 * follows you — the opponent may scroll off when they pull far ahead — and falls back to the
 * leading chicken when spectating a bot-vs-bot race (`myIndex` null). `winLane` clamps the top so
 * the camera never scrolls past the finish; it is injected by the caller (the Vite-bundled board)
 * to keep this file's SDK imports type-only.
 */
export function visibleLanes(
  view: CrossView,
  myIndex: 0 | 1 | null,
  winLane: number = Number.POSITIVE_INFINITY,
): number[] {
  const anchor =
    myIndex !== null
      ? view.players[myIndex]?.lane ?? 0
      : Math.max(view.players[0]?.lane ?? 0, view.players[1]?.lane ?? 0);
  const min = Math.max(0, anchor - 3);
  const max = Math.min(winLane, anchor + 7);
  const out: number[] = [];
  for (let L = max; L >= min; L--) out.push(L);
  return out;
}

export function sessionResult(state: CrossState): SessionResult {
  if (state.winner === "A") return "A";
  if (state.winner === "B") return "B";
  return "push";
}
