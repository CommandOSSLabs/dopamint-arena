/**
 * Pixel Duel protocol: Battleship-Monochrome — a two-seat staked paint duel that
 * runs entirely over a tunnel (1 paint = 1 co-signed move). See ADR 0010.
 * Used by the agent FLEET's commit-reveal duel (agentEngine + duelKit); the
 * in-browser UI duel runs on the simpler PixelPaintProtocol (pixelPaint.ts).
 *
 * Each seat is forced (CLIENT-side) to a single color — A = Sui blue (14), B =
 * pink (5) — and holds a SECRET ~10×10 template placed at a random board location.
 * The template is COMMITTED by hash at open and hidden from the opponent; it never
 * enters protocol state in plaintext until the terminal REVEAL step. Because
 * `encodeState` hashes only public state during play, two clients holding
 * DIFFERENT secret templates still produce IDENTICAL bytes every move — the
 * property that lets the tunnel co-sign without leaking either template.
 *
 * Two layers, kept strictly apart (ADR 0010 §1):
 *  - PROTOCOL (this file, public, co-signed): the paint/own/lock mechanic
 *    borrowed behavior-identical from `pixel_paint.war.v1`, the two 32-byte
 *    template commitments, and the commit-reveal-scoring terminal.
 *  - CLIENT/BOT (not here): monochrome enforcement, secret-template knowledge,
 *    the 1.5s cooldown, the 3s wasted-cell penalty, the 5s memorize guide. The
 *    protocol is intentionally blind to all of these — see the self-harm note on
 *    `scoreSide`: a wasted cross-color paint scores for nobody, so monochrome is a
 *    SELF-IMPOSED rule and protocol-blindness is safe, not a hole.
 *
 * Scoring is INTEGER cross-multiplication, never a float percentage, so the
 * co-signed hash stays canonical and byte-identical on both parties:
 *   coverage A = scoreNumA/templateCellsA  vs  coverage B = scoreNumB/templateCellsB
 *   decided by  scoreNumA*templateCellsB  ⋛  scoreNumB*templateCellsA.
 *
 * Settlement reuses the generic tunnel exactly like tic-tac-toe: the stake shifts
 * loser→winner (clamped to the loser's balance), so balances always sum to total.
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
  lengthPrefixedConcat,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { verifyCommitment, MIN_SALT_LEN } from "../core/commitment";
import { u64ToBeBytes } from "../core/wire";

/** Cell ownership / mark. 0 = empty, 1 = A, 2 = B (= last painter). */
export const EMPTY = 0;
export const OWNER_A = 1;
export const OWNER_B = 2;
/** Number of paintable palette colors; canvas value 0 is reserved for "empty". */
export const NUM_COLORS = 16;

/** Forced seat colors (CLIENT-side). A = Sui blue, B = pink; scoring keys on these. */
export const COLOR_A = 14;
export const COLOR_B = 5;

/** Board geometry and pacing defaults (ADR 0010 §7). */
export const WIDTH = 48;
export const HEIGHT = 40;
export const OVERWRITE_LIMIT = 3;
export const CAP = 1200;

/** Soft template-legality bounds checked at reveal (~10×10 with tolerance). */
export const MIN_TEMPLATE_CELLS = 60;
export const MAX_TEMPLATE_CELLS = 140;

/** 32-byte ZERO sentinel for an un-set commitment (PvP pre-commit) and the hash size. */
export const ZERO32 = new Uint8Array(32);

/** Phase byte. play → reveal (both templates pending) → over (scored + settled). */
export const PHASE_PLAY = 0;
export const PHASE_REVEAL = 1;
export const PHASE_OVER = 2;
export type PixelDuelPhase = "play" | "reveal" | "over";

const PHASE_CODE: Record<PixelDuelPhase, number> = {
  play: PHASE_PLAY,
  reveal: PHASE_REVEAL,
  over: PHASE_OVER,
};

/** Winner codes (mirror tic-tac-toe): 0 none, 1 A, 2 B, 3 draw. */
export type Winner = 0 | 1 | 2 | 3;

export interface PixelDuelConfig {
  width?: number;
  height?: number;
  /** Total placements after which play is terminal (transitions to reveal). */
  cap?: number;
  /** Paints a single cell tolerates before it LOCKS (no one may repaint it). */
  overwriteLimit?: number;
  /** Amount shifted loser→winner on a decisive coverage result. */
  stake?: bigint;
  /**
   * The two template commitments, 32 bytes each (blake2b256 from
   * `computeCommitment(template, salt)`). For the vs-bot / bot-vs-bot driver the
   * driver knows both, so it passes both here. A ZERO32 (or omitted) commit is the
   * un-committed sentinel — a reveal against it is rejected, which is the PvP
   * pre-commit boundary (PvP commit-as-a-move is out of scope, ADR 0010 §6).
   */
  templateCommitA?: Uint8Array;
  templateCommitB?: Uint8Array;
  /** Soft template-cell bounds; defaults to MIN/MAX_TEMPLATE_CELLS. */
  minTemplateCells?: number;
  maxTemplateCells?: number;
}

export interface PixelDuelState {
  phase: PixelDuelPhase;

  // ── board + paint/own/lock mechanic (behavior-identical to pixel_paint.war.v1) ──
  width: number;
  height: number;
  /** width*height palette indices, row-major. 0 = empty, 1..NUM_COLORS = color. */
  canvas: Uint8Array;
  /** width*height owners, row-major. 0 = empty, 1 = A, 2 = B (last painter). */
  owner: Uint8Array;
  /** width*height paint counts. A cell LOCKS when paints[i] === overwriteLimit. */
  paints: Uint8Array;

  placed: number;
  placedA: number;
  placedB: number;
  /** Cells currently owned by each seat (public territory). */
  ownedA: number;
  ownedB: number;
  /** Locked-cell count; when === width*height the board is fully locked (terminal). */
  locked: number;

  // ── commit-reveal for the two secret templates ──
  /** 32-byte commit to each seat's template (ZERO32 = un-committed). */
  templateCommitA: Uint8Array;
  templateCommitB: Uint8Array;
  /** Each seat's template (w*h, 0/1), populated only in reveal→over. Null until revealed. */
  revealedA: Uint8Array | null;
  revealedB: Uint8Array | null;

  // ── scoring snapshot (set at terminal; integers — no floats in the hash) ──
  /** Hit cells: template cells the seat painted its own color. Numerator. */
  scoreNumA: number;
  scoreNumB: number;
  /** Template cell counts (revealed). Denominators for the coverage fraction. */
  templateCellsA: number;
  templateCellsB: number;

  // ── config + settlement ──
  cap: number;
  overwriteLimit: number;
  winner: Winner;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** Amount shifted loser→winner on a decisive result. */
  stake: bigint;
}

/**
 * Two move shapes:
 *  - `paint` during play (the public war mechanic).
 *  - `reveal` at terminal, carrying the seat's secret template + salt. The DRIVER
 *    injects this from locally-held state; `randomMove` can never produce it (it
 *    needs a secret the protocol state lacks).
 */
export type PixelDuelMove =
  | { kind: "paint"; x: number; y: number; color: number }
  | { kind: "reveal"; template: Uint8Array; salt: Uint8Array };

export class PixelDuelProtocol
  implements Protocol<PixelDuelState, PixelDuelMove>
{
  readonly name = "pixel_duel.v1";

  private readonly domain: Uint8Array;
  private readonly width: number;
  private readonly height: number;
  private readonly cap: number;
  private readonly overwriteLimit: number;
  private readonly defaultStake: bigint;
  private readonly commitA: Uint8Array;
  private readonly commitB: Uint8Array;
  private readonly minTemplateCells: number;
  private readonly maxTemplateCells: number;

  constructor(cfg: PixelDuelConfig = {}) {
    this.domain = protocolDomain(this.name);
    this.width = cfg.width ?? WIDTH;
    this.height = cfg.height ?? HEIGHT;
    this.cap = cfg.cap ?? CAP;
    this.overwriteLimit = cfg.overwriteLimit ?? OVERWRITE_LIMIT;
    this.defaultStake = cfg.stake ?? 100n;
    this.minTemplateCells = cfg.minTemplateCells ?? MIN_TEMPLATE_CELLS;
    this.maxTemplateCells = cfg.maxTemplateCells ?? MAX_TEMPLATE_CELLS;

    if (this.width <= 0 || this.height <= 0) {
      throw new Error("canvas dimensions must be positive");
    }
    if (this.cap <= 0) throw new Error("cap must be positive");
    if (this.overwriteLimit < 1) throw new Error("overwriteLimit must be >= 1");
    if (this.defaultStake < 0n) throw new Error("stake must be non-negative");
    if (this.minTemplateCells < 1 || this.maxTemplateCells < this.minTemplateCells) {
      throw new Error("invalid template-cell bounds");
    }

    this.commitA = checkedCommit(cfg.templateCommitA);
    this.commitB = checkedCommit(cfg.templateCommitB);
  }

  initialState(ctx: ProtocolContext): PixelDuelState {
    const size = this.width * this.height;
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    // Stake cannot exceed what either party can actually lose.
    const clampCap =
      ctx.initialBalances.a < ctx.initialBalances.b
        ? ctx.initialBalances.a
        : ctx.initialBalances.b;
    const stake = this.defaultStake < clampCap ? this.defaultStake : clampCap;
    return {
      phase: "play",
      width: this.width,
      height: this.height,
      canvas: new Uint8Array(size),
      owner: new Uint8Array(size),
      paints: new Uint8Array(size),
      placed: 0,
      placedA: 0,
      placedB: 0,
      ownedA: 0,
      ownedB: 0,
      locked: 0,
      templateCommitA: this.commitA,
      templateCommitB: this.commitB,
      revealedA: null,
      revealedB: null,
      scoreNumA: 0,
      scoreNumB: 0,
      templateCellsA: 0,
      templateCellsB: 0,
      cap: this.cap,
      overwriteLimit: this.overwriteLimit,
      winner: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
      stake,
    };
  }

  applyMove(
    state: PixelDuelState,
    move: PixelDuelMove,
    by: Party,
  ): PixelDuelState {
    if (state.winner !== 0) throw new Error("game already over");

    if (move.kind === "paint") {
      if (state.phase !== "play") {
        throw new Error("paint is only legal during play");
      }
      return this.applyPaint(state, move, by);
    }
    if (move.kind === "reveal") {
      if (state.phase !== "reveal") {
        throw new Error("reveal is only legal in the reveal phase");
      }
      return this.applyReveal(state, move, by);
    }
    // Exhaustiveness guard for an out-of-contract move object.
    throw new Error(`unknown move kind: ${(move as { kind: string }).kind}`);
  }

  /** The public war mechanic: paint/own/lock, behavior-identical to pixel_paint.war.v1. */
  private applyPaint(
    state: PixelDuelState,
    move: { x: number; y: number; color: number },
    by: Party,
  ): PixelDuelState {
    const { x, y, color } = move;
    if (!Number.isInteger(x) || x < 0 || x >= state.width) {
      throw new Error(`x out of range: ${x}`);
    }
    if (!Number.isInteger(y) || y < 0 || y >= state.height) {
      throw new Error(`y out of range: ${y}`);
    }
    if (!Number.isInteger(color) || color < 1 || color > NUM_COLORS) {
      throw new Error(`color out of range: ${color}`);
    }

    const idx = y * state.width + x;
    // OVERWRITE LIMIT: a locked cell rejects all painters (including its owner).
    if (state.paints[idx] >= state.overwriteLimit) {
      throw new Error(`cell (${x},${y}) is locked at ${state.overwriteLimit} paints`);
    }

    const canvas = state.canvas.slice();
    const owner = state.owner.slice();
    const paints = state.paints.slice();

    const prevOwner = owner[idx];
    const mine = by === "A" ? OWNER_A : OWNER_B;

    canvas[idx] = color;
    owner[idx] = mine;
    paints[idx] = state.paints[idx] + 1;

    let ownedA = state.ownedA;
    let ownedB = state.ownedB;
    let locked = state.locked;
    if (prevOwner === OWNER_A) ownedA--;
    else if (prevOwner === OWNER_B) ownedB--;
    if (mine === OWNER_A) ownedA++;
    else ownedB++;
    if (paints[idx] === state.overwriteLimit) locked++;

    const placed = state.placed + 1;
    const placedA = state.placedA + (by === "A" ? 1 : 0);
    const placedB = state.placedB + (by === "B" ? 1 : 0);

    // Terminal trigger for the PLAY phase: placement cap OR the whole board
    // locked, whichever first. No winner yet — the duel is decided at reveal.
    const fullyLocked = locked === state.width * state.height;
    const phase: PixelDuelPhase =
      placed >= state.cap || fullyLocked ? "reveal" : "play";

    return {
      ...state,
      canvas,
      owner,
      paints,
      placed,
      placedA,
      placedB,
      ownedA,
      ownedB,
      locked,
      phase,
    };
  }

  /**
   * Verify a seat's template reveal against its commit, soft-check layout, store
   * it. When BOTH seats have revealed, score by coverage cross-multiplication,
   * decide the winner, shift the stake, and settle (phase → over).
   *
   * A reveal whose `(template, salt)` does not match the seat's commitment throws,
   * so the honest party simply never co-signs it — the dispute path of ADR 0010 §8.
   */
  private applyReveal(
    state: PixelDuelState,
    move: { template: Uint8Array; salt: Uint8Array },
    by: Party,
  ): PixelDuelState {
    const { template, salt } = move;
    const size = state.width * state.height;
    const commit = by === "A" ? state.templateCommitA : state.templateCommitB;

    // A ZERO32 commit is the un-committed sentinel: nothing binds this reveal.
    if (bytesAllZero(commit)) {
      throw new Error(`seat ${by} has no template commitment`);
    }
    if (template.length !== size) {
      throw new Error(`template length ${template.length} !== ${size}`);
    }
    if (salt.length < MIN_SALT_LEN) {
      throw new Error(`salt must be >= ${MIN_SALT_LEN} bytes`);
    }
    // Soft layout legality: pure 0/1 mask, cell count within the expected band.
    let cells = 0;
    for (let i = 0; i < size; i++) {
      const v = template[i];
      if (v !== 0 && v !== 1) {
        throw new Error(`template byte at ${i} is not 0/1: ${v}`);
      }
      if (v === 1) cells++;
    }
    if (cells < this.minTemplateCells || cells > this.maxTemplateCells) {
      throw new Error(
        `template cell count ${cells} outside [${this.minTemplateCells},${this.maxTemplateCells}]`,
      );
    }
    // COMMIT BINDING: blake2b256-length-prefixed, byte-identical to randomness.move.
    if (!verifyCommitment(commit, template, salt)) {
      throw new Error(`seat ${by} reveal does not match its commitment`);
    }

    const stored = template.slice();
    let revealedA = state.revealedA;
    let revealedB = state.revealedB;
    let templateCellsA = state.templateCellsA;
    let templateCellsB = state.templateCellsB;
    if (by === "A") {
      if (revealedA) throw new Error("seat A already revealed");
      revealedA = stored;
      templateCellsA = cells;
    } else {
      if (revealedB) throw new Error("seat B already revealed");
      revealedB = stored;
      templateCellsB = cells;
    }

    // First reveal: wait for the second before scoring. Still in reveal phase.
    if (!revealedA || !revealedB) {
      return {
        ...state,
        revealedA,
        revealedB,
        templateCellsA,
        templateCellsB,
      };
    }

    // Both revealed: score each side's coverage, then decide + settle.
    const scoreNumA = scoreSide(state.canvas, revealedA, COLOR_A);
    const scoreNumB = scoreSide(state.canvas, revealedB, COLOR_B);

    // Coverage as a fraction, compared by integer cross-multiplication — no float
    // ever enters the hash. coverageA = scoreNumA/cellsA, coverageB = .../cellsB.
    const lhs = scoreNumA * templateCellsB;
    const rhs = scoreNumB * templateCellsA;
    const winner: Winner = lhs > rhs ? 1 : rhs > lhs ? 2 : 3;

    let balanceA = state.balanceA;
    let balanceB = state.balanceB;
    if (winner === 1 || winner === 2) {
      const loserBal = winner === 1 ? state.balanceB : state.balanceA;
      const shift = state.stake < loserBal ? state.stake : loserBal;
      if (winner === 1) {
        balanceA = state.balanceA + shift;
        balanceB = state.balanceB - shift;
      } else {
        balanceA = state.balanceA - shift;
        balanceB = state.balanceB + shift;
      }
    }
    // winner === 3 (draw): balances unchanged.

    return {
      ...state,
      phase: "over",
      revealedA,
      revealedB,
      templateCellsA,
      templateCellsB,
      scoreNumA,
      scoreNumB,
      winner,
      balanceA,
      balanceB,
    };
  }

  encodeState(state: PixelDuelState): Uint8Array {
    // Templates enter the encoding ONLY after reveal (length-prefixed, ∅ until
    // then), so during play both clients hash identically regardless of their
    // hidden templates. All other fields are fixed-width, keeping it canonical.
    return concatBytes([
      this.domain,
      u64ToBeBytes(BigInt(state.width)),
      u64ToBeBytes(BigInt(state.height)),
      state.canvas,
      state.owner,
      state.paints,
      u64ToBeBytes(BigInt(state.placed)),
      u64ToBeBytes(BigInt(state.placedA)),
      u64ToBeBytes(BigInt(state.placedB)),
      u64ToBeBytes(BigInt(state.ownedA)),
      u64ToBeBytes(BigInt(state.ownedB)),
      u64ToBeBytes(BigInt(state.locked)),
      Uint8Array.of(PHASE_CODE[state.phase]),
      state.templateCommitA,
      state.templateCommitB,
      lengthPrefixedConcat([
        state.revealedA ?? new Uint8Array(0),
        state.revealedB ?? new Uint8Array(0),
      ]),
      u64ToBeBytes(BigInt(state.scoreNumA)),
      u64ToBeBytes(BigInt(state.scoreNumB)),
      u64ToBeBytes(BigInt(state.templateCellsA)),
      u64ToBeBytes(BigInt(state.templateCellsB)),
      u64ToBeBytes(BigInt(state.cap)),
      Uint8Array.of(state.overwriteLimit),
      Uint8Array.of(state.winner),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
      u64ToBeBytes(state.stake),
    ]);
  }

  balances(state: PixelDuelState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: PixelDuelState): boolean {
    return state.winner !== 0;
  }

  /**
   * Only ever a legal `paint` during play (null in reveal/over). The driver
   * injects the `reveal` from locally-held template+salt — `randomMove` cannot,
   * since the secret is absent from protocol state.
   */
  randomMove(
    state: PixelDuelState,
    by: Party,
    rng: () => number,
  ): PixelDuelMove | null {
    if (state.phase !== "play" || state.winner !== 0) return null;
    const free: number[] = [];
    for (let i = 0; i < state.paints.length; i++) {
      if (state.paints[i] < state.overwriteLimit) free.push(i);
    }
    if (free.length === 0) return null;
    const idx = free[Math.min(free.length - 1, Math.floor(rng() * free.length))];
    // A bot self-imposes its seat color (monochrome); the protocol accepts any.
    const color = by === "A" ? COLOR_A : COLOR_B;
    return { kind: "paint", x: idx % state.width, y: (idx / state.width) | 0, color };
  }
}

/**
 * Count template cells the seat painted its OWN color: hits where
 * `canvas[i] === seatColor` AND `template[i] === 1`. A wasted cross-color paint
 * (e.g. A painting color 5 on its own template cell) matches NEITHER seat's
 * count, which is exactly why monochrome can be a self-imposed client rule.
 */
function scoreSide(
  canvas: Uint8Array,
  template: Uint8Array,
  seatColor: number,
): number {
  let n = 0;
  for (let i = 0; i < template.length; i++) {
    if (template[i] === 1 && canvas[i] === seatColor) n++;
  }
  return n;
}

/** A 32-byte commitment, or ZERO32 when omitted/empty (the un-committed sentinel). */
function checkedCommit(commit: Uint8Array | undefined): Uint8Array {
  if (commit === undefined) return ZERO32;
  if (commit.length !== 32) {
    throw new Error(`template commitment must be 32 bytes, got ${commit.length}`);
  }
  return commit;
}

function bytesAllZero(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}
