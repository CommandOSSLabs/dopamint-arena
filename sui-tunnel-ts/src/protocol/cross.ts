/**
 * Chicken Cross protocol: a TWO-PARTY lane-hopper race over a tunnel.
 *
 * A discrete, deterministic reformulation of the standalone Crossy-Road reference
 * (which used a continuous 25 Hz server sim). Here every world advance is ONE tick =
 * one dual-signed state update; hazard positions are a pure function of
 * (seed, laneIndex, tick), so both parties — and an on-chain disputer replaying
 * encodeState — agree on every collision with no trusted server.
 *
 * Party A and Party B are two chickens racing for a pot of 2S (each stakes S). A real
 * finish is winner-take-all: first to cross WIN_LANE takes (2S, 0) / (0, 2S). Every OTHER
 * reachable state carries the fair settle-if-halted-here split by progress (see
 * `settleShare`), so an abandoned race settles by how far each chicken got — a trailing
 * chicken can't stall for a refund-draw. balanceA + balanceB === total always holds
 * (required by OffchainTunnel.step), since balanceB = total - balanceA.
 *
 * PvP fairness: the seed is a deterministic function of the Sui-assigned tunnelId, NOT a
 * commit-reveal. Safe here because the hazard field is PUBLIC and identical for both seats —
 * neither party holds hidden state it could bias, and the tunnelId cannot be ground.
 * Commit-reveal is reserved for hidden-information games (see docs/decisions/0010).
 */

import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import {
  Balances,
  Party,
  Protocol,
  ProtocolContext,
  protocolDomain,
} from "./Protocol";

// ============================================
// CONFIG
// ============================================

/** Columns 0..COLUMN_COUNT-1. */
export const COLUMN_COUNT = 9;
/** Spawn / respawn column (center). */
export const SPAWN_COL = 4;
/** Finish line — reachable within the tick budget so a race ends DECISIVELY (first chicken to
 *  cross takes the pot), not in a score-tie push at the cap. One seat hops per tick (2-party
 *  model), so each chicken advances every other tick; 600 keeps the race ~30s at the self-play
 *  rate. (Two seats can no longer cross on the same tick, so a finish-line dead heat can't occur.) */
export const WIN_LANE = 600;
/** Backstop only: if a race stalls and neither chicken crosses, the higher score wins at this
 *  cap (tie ⇒ push). Normal races finish well before it. */
export const TICK_CAP = 5400n;
/** Ticks of collision immunity after a respawn (also blocks moving, per the reference). */
export const RESPAWN_INVULN = 3;
/** Minimum fundable stake per seat (hook clamps to this). */
export const MIN_STAKE = 1n;

export type CrossDir = "north" | "south" | "east" | "west";
export type CrossLaneKind = "grass" | "road" | "water" | "rails";

/** A hazard's horizontal span on a lane: center column ± half-width. */
export interface HazardSpan {
  center: number;
  half: number;
}

// ============================================
// DETERMINISTIC HAZARD FIELD (pure)
// ============================================

/** Small, fast, fully deterministic PRNG (Mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True modulo (handles negatives), result in [0, m). */
function mod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

/** Lane archetype, cycling grass,grass,road,road,water,rails from lane 2 (lanes 0,1 grass). */
export function laneKind(lane: number): CrossLaneKind {
  if (lane < 2) return "grass";
  const k = (lane - 2) % 6;
  if (k === 0 || k === 1) return "road";
  if (k === 2) return "water";
  if (k === 3) return "rails";
  return "grass"; // k === 4 || k === 5
}

/** Per-lane RNG, seeded deterministically from (seed, lane). */
function laneRng(seed: bigint, lane: number): () => number {
  const mixed = (seed ^ (BigInt(lane) * 0x9e3779b1n)) & 0xffffffffn;
  return mulberry32(Number(mixed));
}

/**
 * Hazard spans occupying a lane at `tick`, as a pure function of (seed, lane, tick).
 * Roads carry narrow cars, water carries wide logs (platforms), rails a very wide train.
 * Positions sweep across the columns at a seeded speed and wrap at COLUMN_COUNT.
 */
export function hazardsAt(
  seed: bigint,
  lane: number,
  tick: bigint
): HazardSpan[] {
  const kind = laneKind(lane);
  if (kind === "grass") return [];
  const rng = laneRng(seed, lane);
  // Bound the tick for float stability across very long games (positions stay periodic).
  const t = Number(tick % 1048576n);
  const spans: HazardSpan[] = [];

  if (kind === "road") {
    const count = rng() < 0.5 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const speed = 0.1 + rng() * 0.1;
      const dir = rng() < 0.5 ? 1 : -1;
      const phase = rng() * COLUMN_COUNT;
      spans.push({
        center: mod(phase + dir * speed * t, COLUMN_COUNT),
        half: 0.9,
      });
    }
  } else if (kind === "water") {
    const count = rng() < 0.5 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const speed = 0.06 + rng() * 0.05;
      const dir = rng() < 0.5 ? 1 : -1;
      const phase = rng() * COLUMN_COUNT + i * 3;
      spans.push({
        center: mod(phase + dir * speed * t, COLUMN_COUNT),
        half: 1.4,
      });
    }
  } else {
    // rails
    const speed = 0.2 + rng() * 0.15;
    const dir = rng() < 0.5 ? 1 : -1;
    const phase = rng() * COLUMN_COUNT;
    spans.push({
      center: mod(phase + dir * speed * t, COLUMN_COUNT),
      half: 3.0,
    });
  }
  return spans;
}

/** Strict-exclusive overlap test (chicken center = col + 0.5), accounting for wrap. */
export function spanCoversCol(span: HazardSpan, col: number): boolean {
  const c = col + 0.5;
  for (const cc of [c, c - COLUMN_COUNT, c + COLUMN_COUNT]) {
    if (cc > span.center - span.half && cc < span.center + span.half)
      return true;
  }
  return false;
}

/**
 * Is the cell (col, lane) lethal at `tick`? grass = safe; road/rails = lethal when a
 * hazard overlaps; water = INVERTED (open water kills; a log saves). Behind spawn = lethal.
 */
export function isLethal(
  seed: bigint,
  col: number,
  lane: number,
  tick: bigint
): boolean {
  if (lane < 0) return true;
  const kind = laneKind(lane);
  if (kind === "grass") return false;
  const onHazard = hazardsAt(seed, lane, tick).some((s) =>
    spanCoversCol(s, col)
  );
  if (kind === "water") return !onHazard;
  return onHazard;
}

/** Destination cell for a hop, clamped to the board. */
export function destOf(
  lane: number,
  col: number,
  dir: CrossDir
): [number, number] {
  if (dir === "north") return [lane + 1, col];
  if (dir === "south") return [Math.max(0, lane - 1), col];
  if (dir === "east") return [lane, Math.min(COLUMN_COUNT - 1, col + 1)];
  return [lane, Math.max(0, col - 1)]; // west
}

// ============================================
// PROTOCOL STATE
// ============================================

export interface CrossPlayer {
  /** 0 = spawn, increasing = forward. */
  lane: number;
  /** Integer column 0..COLUMN_COUNT-1. */
  col: number;
  /** Furthest lane reached this run (survives respawn). */
  score: number;
  /** Post-respawn immunity countdown (blocks both death and moving). */
  invulnTicks: number;
}

export interface CrossState {
  tick: bigint;
  /** Hazard-field seed; derived from tunnelId; part of encodeState for exact replay. */
  seed: bigint;
  players: [CrossPlayer, CrossPlayer]; // index 0 = A, 1 = B
  winner: Party | null;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

/** One world tick: each side's intended hop (or undefined = stay). */
export interface CrossMove {
  dirA?: CrossDir;
  dirB?: CrossDir;
}

const DOMAIN = protocolDomain("cross.v1");

function spawnPlayer(): CrossPlayer {
  return { lane: 0, col: SPAWN_COL, score: 0, invulnTicks: 0 };
}

/** Deterministic 32-bit seed from a tunnel object id string. */
function seedFromTunnelId(tunnelId: string): bigint {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < tunnelId.length; i++) {
    h ^= tunnelId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return BigInt(h >>> 0);
}

/** Advance one player one tick: optional hop, log-rescue via inverted-water, then collision/respawn. */
function stepPlayer(
  seed: bigint,
  p: CrossPlayer,
  dir: CrossDir | undefined,
  tick: bigint
): CrossPlayer {
  // Post-respawn immunity: no move, no death, just tick down.
  if (p.invulnTicks > 0) {
    return {
      lane: p.lane,
      col: p.col,
      score: p.score,
      invulnTicks: p.invulnTicks - 1,
    };
  }
  let lane = p.lane;
  let col = p.col;
  // You may NOT voluntarily hop into a known-lethal cell (reference rule).
  if (dir) {
    const [nl, nc] = destOf(lane, col, dir);
    if (!isLethal(seed, nc, nl, tick)) {
      lane = nl;
      col = nc;
    }
  }
  const score = Math.max(p.score, lane);
  // Standing-cell death: e.g. the log you stood on drifted away (water), or a car swept in.
  if (isLethal(seed, col, lane, tick)) {
    return { lane: 0, col: SPAWN_COL, score, invulnTicks: RESPAWN_INVULN };
  }
  return { lane, col, score, invulnTicks: 0 };
}

/** Greedy bot dir for player index `i`: prefer forward, dodge sideways, avoid back, else stay. */
function greedyDir(
  s: CrossState,
  i: number,
  rng: () => number
): CrossDir | undefined {
  const p = s.players[i];
  if (p.invulnTicks > 0) return undefined;
  const tick = s.tick + 1n;
  // Seat-biased exploration (A drifts east, B drifts west) so the chickens take different hazard
  // timings and a clear leader emerges — fewer dead-heat pushes. North (forward) always first.
  const near: CrossDir = i === 0 ? "east" : "west";
  const far: CrossDir = i === 0 ? "west" : "east";
  const order: CrossDir[] =
    rng() < 0.8 ? ["north", near, far] : ["north", far, near];
  for (const d of order) {
    const [nl, nc] = destOf(p.lane, p.col, d);
    if (!isLethal(s.seed, nc, nl, tick)) return d;
  }
  // Keep moving rather than idle (the chicken never stops): back up if it's safe.
  const [sl, sc] = destOf(p.lane, p.col, "south");
  if (!isLethal(s.seed, sc, sl, tick)) return "south";
  // Every neighbor is lethal: hold if our current cell survives, else we're doomed (respawn).
  return undefined;
}

// ============================================
// SETTLEMENT — the cash-out invariant
// ============================================

/**
 * Party A's settle-if-halted-here share of `total`, from both chickens' furthest-lane
 * `score`s. The lead (scoreA - scoreB) maps linearly to the split as a fraction of the
 * full race `distance`: level ⇒ 50/50; a full-distance lead ⇒ winner-take-all; clamped
 * between. Monotone in scoreA (and decreasing in scoreB), so a chicken that stops
 * advancing only watches its share erode as the opponent moves — stalling is strictly
 * self-harming, never a way to force a refund-draw. Uses `score` (never current `lane`)
 * so a respawn can't lower a locked claim (strategyproof). Pair with
 * `balanceB = total - settleShare(...)` so the pot is conserved exactly despite flooring.
 * Mirrored byte-for-byte by the Rust `settle_share` in `rust/protocols/cross`.
 */
export function settleShare(
  total: bigint,
  scoreA: number,
  scoreB: number,
  distance: number = WIN_LANE
): bigint {
  const lead = Math.max(-distance, Math.min(distance, scoreA - scoreB));
  return (total * BigInt(distance + lead)) / BigInt(2 * distance);
}

// ============================================
// PROTOCOL
// ============================================

export class CrossProtocol implements Protocol<CrossState, CrossMove> {
  readonly name = "cross.v1";

  initialState(ctx: ProtocolContext): CrossState {
    return {
      tick: 0n,
      seed: seedFromTunnelId(ctx.tunnelId),
      players: [spawnPlayer(), spawnPlayer()],
      winner: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
    };
  }

  applyMove(state: CrossState, move: CrossMove, by: Party): CrossState {
    if (this.isTerminal(state)) {
      throw new Error("game over: the race is already decided");
    }
    // Integrity: a seat may only carry its OWN hop (hardens vs a forged opponent move).
    if (by === "A" && move.dirB !== undefined)
      throw new Error("A cannot submit B's direction");
    if (by === "B" && move.dirA !== undefined)
      throw new Error("B cannot submit A's direction");
    const tick = state.tick + 1n;
    const players: [CrossPlayer, CrossPlayer] = [
      stepPlayer(state.seed, state.players[0], move.dirA, tick),
      stepPlayer(state.seed, state.players[1], move.dirB, tick),
    ];

    let winner: Party | null = null;
    const aWon = players[0].lane >= WIN_LANE;
    const bWon = players[1].lane >= WIN_LANE;
    // Simultaneous double-arrival: higher score wins; an exact dead heat is a PUSH (winner
    // null), matching the TICK_CAP tie path below. Resolving by score is replay-stable so both
    // parties agree, and the push removes the old seat-A bias in human-vs-human PvP.
    if (aWon && bWon) {
      if (players[0].score > players[1].score) winner = "A";
      else if (players[1].score > players[0].score) winner = "B";
      else winner = null;
    } else if (aWon) winner = "A";
    else if (bWon) winner = "B";
    else if (tick >= TICK_CAP) {
      if (players[0].score > players[1].score) winner = "A";
      else if (players[1].score > players[0].score) winner = "B";
      else winner = null; // push at the cap
    }

    // Winner-take-all at a real finish; otherwise every co-signed state already carries
    // the fair split-if-halted-here (by progress), so an abandoned race settles fairly and
    // no trailing chicken can stall for a refund-draw.
    let balanceA: bigint;
    let balanceB: bigint;
    if (winner === "A") {
      balanceA = state.total;
      balanceB = 0n;
    } else if (winner === "B") {
      balanceA = 0n;
      balanceB = state.total;
    } else {
      balanceA = settleShare(state.total, players[0].score, players[1].score);
      balanceB = state.total - balanceA;
    }
    return { ...state, tick, players, winner, balanceA, balanceB };
  }

  encodeState(s: CrossState): Uint8Array {
    const parts: Uint8Array[] = [
      DOMAIN,
      u64ToBeBytes(s.tick),
      u64ToBeBytes(s.seed),
      u64ToBeBytes(s.balanceA),
      u64ToBeBytes(s.balanceB),
    ];
    for (const p of s.players) {
      parts.push(
        u64ToBeBytes(p.lane),
        u64ToBeBytes(p.col),
        u64ToBeBytes(p.score),
        u64ToBeBytes(p.invulnTicks)
      );
    }
    parts.push(
      new Uint8Array([s.winner === "A" ? 1 : s.winner === "B" ? 2 : 0])
    );
    return concatBytes(parts);
  }

  balances(s: CrossState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: CrossState): boolean {
    return s.winner !== null || s.tick >= TICK_CAP;
  }

  randomMove(s: CrossState, by: Party, rng: () => number): CrossMove | null {
    if (this.isTerminal(s)) return null;
    // One co-signed update is one seat's hop (the other implicitly stays), per the 2-party
    // tunnel model — return only `by`'s move, never both.
    return by === "A"
      ? { dirA: greedyDir(s, 0, rng) }
      : { dirB: greedyDir(s, 1, rng) };
  }
}
