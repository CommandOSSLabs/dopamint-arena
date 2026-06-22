/**
 * Pure, React-free view + self-play driver for Bomb It. Only TYPE imports from the SDK so it
 * runs under tsx (the alias is not resolved at runtime). The hook owns keypairs, the timer, and
 * the on-chain open/close; BombBoard.tsx (Vite-bundled) owns rendering.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { BombItProtocol, BombItState, BombItMove } from "sui-tunnel-ts/protocol/bombIt";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";

/** Flat, render-friendly snapshot of a BombItState (bigints -> numbers). */
export interface BombItView {
  tick: number;
  grid: number[]; // 81 cells: 0 floor, 1 wall, 2 crate
  players: { row: number; col: number; alive: boolean }[];
  bombs: { row: number; col: number; fuse: number; owner: "A" | "B" }[];
  winner: "A" | "B" | "draw" | null;
  balanceA: number;
  balanceB: number;
}

/** Who took the pot (or a push). */
export type BombItResult = "A" | "B" | "draw";

export function deriveView(state: BombItState): BombItView {
  return {
    tick: Number(state.tick),
    grid: Array.from(state.grid),
    players: state.players.map((p) => ({ row: p.row, col: p.col, alive: p.alive })),
    bombs: state.bombs.map((b) => ({ row: b.row, col: b.col, fuse: b.fuse, owner: b.owner })),
    winner: state.winner,
    balanceA: Number(state.balanceA),
    balanceB: Number(state.balanceB),
  };
}

export function sessionResult(state: BombItState): BombItResult {
  if (state.winner === "A") return "A";
  if (state.winner === "B") return "B";
  // winner === "draw" OR null (in-progress): both map to the neutral "draw" result.
  return "draw";
}

/**
 * Advance the self-play session by one world tick. Returns false once the game is terminal — the
 * benchmark loop then stops stepping and settles. `by` alternates by tick parity purely for
 * signing attribution: only the acting seat moves, the protocol implicitly stays the other.
 * Each call produces exactly one dual-signed update (the TPS unit). Mirrors the chicken-cross
 * self-play stepper so the two games stay grep-able as a pair.
 */
export function stepSession(
  protocol: BombItProtocol,
  tunnel: OffchainTunnel<BombItState, BombItMove>,
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
