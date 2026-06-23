/**
 * Pure, React-free view driver for Bomb It. Only TYPE imports from the SDK so it runs under
 * tsx (the alias is not resolved at runtime). The hook owns keypairs, the timer, and the
 * on-chain open/close; BombBoard.tsx (Vite-bundled) owns rendering.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { BombItProtocol, BombItState, BombItMove, BombItAction } from "sui-tunnel-ts/protocol/bombIt";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";

/**
 * Solo tick cadence (one co-signed tick per this many ms). Bomb It is a REACTION game: unlike
 * chicken-cross's high-throughput showcase loop (which batches many ticks per frame), the bomb
 * fuse and the bot fight must read as real time. `FUSE_TICKS (8) * SOLO_STEP_MS` ≈ the fuse's
 * wall-clock life — kept near ~1s so a manual player can drop-and-flee and a bot duel is
 * watchable. (PvP paces itself separately over the relay.)
 */
export const SOLO_STEP_MS = 120;

/** When the human takes over a seat (auto mode off), the loop supplies its action for that seat;
 *  the other seat (and both seats while auto is on) is driven by the protocol's hunter bot. */
export interface HumanSeat {
  seat: Party;
  getAction: () => BombItAction;
}

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

/**
 * Advance a self-play (bot-vs-bot) session by one tick. Each tick ONE seat acts (the
 * protocol implicitly stays the other), alternating by tick parity to match how the
 * engine attributes signatures. Returns false at a terminal state so the caller stops
 * the timer and settles. RNG is injected so the test (and an on-chain replay) is
 * deterministic; the live hook passes Math.random.
 */
export function stepSession(
  protocol: BombItProtocol,
  tunnel: OffchainTunnel<BombItState, BombItMove>,
  rng: () => number,
  human?: HumanSeat | null,
): boolean {
  const state = tunnel.state;
  if (protocol.isTerminal(state)) return false;
  const by: Party = state.tick % 2n === 0n ? "A" : "B";
  let move: BombItMove | null;
  if (human && human.seat === by) {
    const a = human.getAction();
    move = by === "A" ? { a } : { b: a };
  } else {
    move = protocol.randomMove(state, by, rng);
  }
  if (!move) return false;
  tunnel.step(move, by);
  return true;
}

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
