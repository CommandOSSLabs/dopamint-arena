/**
 * Battleship protocol: a two-party staked game over a tunnel, with hidden fleets.
 *
 * Unlike TicTacToe, the co-signed state is PUBLIC ONLY — board commitments and
 * revealed shot results — never the secret fleets. `encodeState` therefore
 * hashes the same bytes on both clients even though each holds a different
 * secret board. Fairness comes from commit-reveal: each side commits a Merkle
 * root at placement, and every shot is answered by a `reveal` whose Merkle proof
 * is verified here against that root, so a peer cannot advance state with a lie.
 * See ADR 0003.
 *
 * Flow: A commits, B commits (phase -> playing), then players alternate
 * shoot/reveal. A shot sets `pendingShot`; the defender's matching `reveal`
 * records the hit/miss and passes the turn. A player loses when all
 * {@link FLEET_CELLS} of their cells have been revealed as hits; `stake` then
 * shifts loser -> winner (clamped), keeping balances summed to the locked total.
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  otherParty,
  protocolDomain,
  lengthPrefixedConcat,
} from "sui-tunnel-ts/protocol/Protocol";
import { concatBytes, fromHex, toHex } from "sui-tunnel-ts/core/bytes";
import { u64ToBeBytes } from "sui-tunnel-ts/core/wire";
import type { MoveCodec } from "sui-tunnel-ts/core/distributedFrame";
import { CELL_COUNT, FLEET_CELLS } from "../engine/fleet";
import { SALT_BYTES, verifyCell } from "../engine/merkle";

/** Winner codes: 0 none, 1 A, 2 B. (Battleship has no draw.) */
export type Winner = 0 | 1 | 2;
export type Phase = "awaitingCommits" | "playing" | "over";

export interface ShotResult {
  cell: number;
  isHit: boolean;
}

export interface BattleshipState {
  phase: Phase;
  /** Whose turn it is to fire. A always fires first. */
  turn: Party;
  /** A fired shot awaiting the defender's reveal, or null between turns. */
  pendingShot: { by: Party; cell: number } | null;
  /** 32-byte Merkle roots; null until that party has committed its fleet. */
  commitA: Uint8Array | null;
  commitB: Uint8Array | null;
  /** Shots fired at A's board (by B), and at B's board (by A), in order. */
  shotsAtA: ShotResult[];
  shotsAtB: ShotResult[];
  /** Confirmed hits on each fleet; a player loses at FLEET_CELLS. */
  hitsOnA: number;
  hitsOnB: number;
  winner: Winner;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  /** Amount shifted loser -> winner on a decisive result. */
  stake: bigint;
}

export type BattleshipMove =
  | { type: "commit"; root: Uint8Array }
  | { type: "shoot"; cell: number }
  | {
      type: "reveal";
      cell: number;
      isShip: boolean;
      salt: Uint8Array;
      proof: Uint8Array[];
    };

const DOMAIN = protocolDomain("battleship.v1");
const COMMIT_BYTES = 32;

const PHASE_CODE: Record<Phase, number> = {
  awaitingCommits: 0,
  playing: 1,
  over: 2,
};

function commitFor(state: BattleshipState, party: Party): Uint8Array | null {
  return party === "A" ? state.commitA : state.commitB;
}

/** Shots already fired at `defender`'s board. */
function shotsAt(state: BattleshipState, defender: Party): ShotResult[] {
  return defender === "A" ? state.shotsAtA : state.shotsAtB;
}

export class BattleshipProtocol implements Protocol<
  BattleshipState,
  BattleshipMove
> {
  readonly name = "battleship.v1";

  private readonly defaultStake: bigint;

  constructor(stake: bigint = 100n) {
    if (stake < 0n) throw new Error("stake must be non-negative");
    this.defaultStake = stake;
  }

  initialState(ctx: ProtocolContext): BattleshipState {
    const total = ctx.initialBalances.a + ctx.initialBalances.b;
    const cap =
      ctx.initialBalances.a < ctx.initialBalances.b
        ? ctx.initialBalances.a
        : ctx.initialBalances.b;
    const stake = this.defaultStake < cap ? this.defaultStake : cap;
    return {
      phase: "awaitingCommits",
      turn: "A",
      pendingShot: null,
      commitA: null,
      commitB: null,
      shotsAtA: [],
      shotsAtB: [],
      hitsOnA: 0,
      hitsOnB: 0,
      winner: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total,
      stake,
    };
  }

  applyMove(
    state: BattleshipState,
    move: BattleshipMove,
    by: Party,
  ): BattleshipState {
    if (state.phase === "over" || state.winner !== 0) {
      throw new Error("game already over");
    }
    switch (move.type) {
      case "commit":
        return this.applyCommit(state, move.root, by);
      case "shoot":
        return this.applyShoot(state, move.cell, by);
      case "reveal":
        return this.applyReveal(state, move, by);
      default: {
        const exhaustive: never = move;
        throw new Error(`unknown move: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private applyCommit(
    state: BattleshipState,
    root: Uint8Array,
    by: Party,
  ): BattleshipState {
    if (state.phase !== "awaitingCommits")
      throw new Error("commits are closed");
    if (root.length !== COMMIT_BYTES) {
      throw new Error(`commitment must be ${COMMIT_BYTES} bytes`);
    }
    // Commits are ordered A then B, matching the co-sign one-proposal-at-a-time model.
    if (state.commitA === null) {
      if (by !== "A") throw new Error("A commits first");
    } else if (state.commitB === null) {
      if (by !== "B") throw new Error("B commits second");
    } else {
      throw new Error("both fleets already committed");
    }

    const next: BattleshipState = {
      ...state,
      commitA: by === "A" ? root.slice() : state.commitA,
      commitB: by === "B" ? root.slice() : state.commitB,
    };
    if (next.commitA !== null && next.commitB !== null) {
      next.phase = "playing";
      next.turn = "A";
    }
    return next;
  }

  private applyShoot(
    state: BattleshipState,
    cell: number,
    by: Party,
  ): BattleshipState {
    if (state.phase !== "playing") throw new Error("not in the firing phase");
    if (state.pendingShot)
      throw new Error("awaiting the previous shot's reveal");
    if (by !== state.turn) throw new Error(`not ${by}'s turn`);
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT) {
      throw new Error(`cell out of range: ${cell}`);
    }
    const defender = otherParty(by);
    if (shotsAt(state, defender).some((s) => s.cell === cell)) {
      throw new Error(`already fired at cell ${cell}`);
    }
    return { ...state, pendingShot: { by, cell } };
  }

  private applyReveal(
    state: BattleshipState,
    move: Extract<BattleshipMove, { type: "reveal" }>,
    by: Party,
  ): BattleshipState {
    const pending = state.pendingShot;
    if (state.phase !== "playing" || !pending)
      throw new Error("no shot to reveal");
    // The defender (the party that was shot at) reveals their own cell.
    if (by !== otherParty(pending.by))
      throw new Error("only the defender reveals");
    if (move.cell !== pending.cell)
      throw new Error("reveal must answer the pending shot");
    if (move.salt.length !== SALT_BYTES) throw new Error("bad salt length");

    const commit = commitFor(state, by);
    if (!commit) throw new Error("defender has not committed");
    if (!verifyCell(commit, move.cell, move.isShip, move.salt, move.proof)) {
      throw new Error("reveal proof does not match the committed board");
    }

    const result: ShotResult = { cell: move.cell, isHit: move.isShip };
    const shotsAtA = by === "A" ? [...state.shotsAtA, result] : state.shotsAtA;
    const shotsAtB = by === "B" ? [...state.shotsAtB, result] : state.shotsAtB;
    const hitsOnA =
      by === "A" && move.isShip ? state.hitsOnA + 1 : state.hitsOnA;
    const hitsOnB =
      by === "B" && move.isShip ? state.hitsOnB + 1 : state.hitsOnB;

    let winner: Winner = 0;
    if (hitsOnB === FLEET_CELLS)
      winner = 1; // B's fleet destroyed -> A wins
    else if (hitsOnA === FLEET_CELLS) winner = 2; // A's fleet destroyed -> B wins

    let { balanceA, balanceB } = state;
    if (winner !== 0) {
      const loserBal = winner === 1 ? state.balanceB : state.balanceA;
      const shift = state.stake < loserBal ? state.stake : loserBal;
      if (winner === 1) {
        balanceA += shift;
        balanceB -= shift;
      } else {
        balanceA -= shift;
        balanceB += shift;
      }
    }

    return {
      ...state,
      shotsAtA,
      shotsAtB,
      hitsOnA,
      hitsOnB,
      winner,
      balanceA,
      balanceB,
      phase: winner !== 0 ? "over" : "playing",
      // The defender fires next; clear the pending shot.
      pendingShot: null,
      turn: by,
    };
  }

  encodeState(state: BattleshipState): Uint8Array {
    const pend = state.pendingShot;
    const fixed = Uint8Array.of(
      PHASE_CODE[state.phase],
      state.turn === "A" ? 0 : 1,
      pend ? 1 : 0,
      pend ? (pend.by === "A" ? 0 : 1) : 0,
      pend ? pend.cell : 0,
      state.hitsOnA,
      state.hitsOnB,
      state.winner,
    );
    const shotBytes = (shots: ShotResult[]): Uint8Array => {
      const out = new Uint8Array(shots.length * 2);
      for (let i = 0; i < shots.length; i++) {
        out[i * 2] = shots[i].cell;
        out[i * 2 + 1] = shots[i].isHit ? 1 : 0;
      }
      return out;
    };
    const empty = new Uint8Array(0);
    return concatBytes([
      DOMAIN,
      fixed,
      // Length-prefixed so the variable-length parts have unambiguous boundaries.
      lengthPrefixedConcat([
        state.commitA ?? empty,
        state.commitB ?? empty,
        shotBytes(state.shotsAtA),
        shotBytes(state.shotsAtB),
      ]),
      u64ToBeBytes(state.balanceA),
      u64ToBeBytes(state.balanceB),
      u64ToBeBytes(state.stake),
    ]);
  }

  balances(state: BattleshipState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: BattleshipState): boolean {
    return state.winner !== 0;
  }

  /**
   * Only the secret-free `shoot` move can be produced from public state. `commit`
   * and `reveal` require the fleet secrets the protocol deliberately does not
   * hold, so self-play is driven by the session (which owns both fleets), not by
   * this method. Returns null when it is not `by`'s turn to fire. See ADR 0003.
   */
  randomMove(
    state: BattleshipState,
    by: Party,
    rng: () => number,
  ): BattleshipMove | null {
    if (state.phase !== "playing" || state.pendingShot || by !== state.turn) {
      return null;
    }
    const fired = new Set(shotsAt(state, otherParty(by)).map((s) => s.cell));
    const open: number[] = [];
    for (let cell = 0; cell < CELL_COUNT; cell++)
      if (!fired.has(cell)) open.push(cell);
    if (open.length === 0) return null;
    const idx = Math.min(open.length - 1, Math.floor(rng() * open.length));
    return { type: "shoot", cell: open[idx] };
  }
}

/**
 * Move (de)serializer for the PvP relay. The frame envelope is JSON, which can't
 * carry the move's binary fields (commit root, salt, Merkle proof) — those are
 * hex-encoded here and restored on the far side. Pass as the tunnel's `moveCodec`.
 */
export const battleshipMoveCodec: MoveCodec<BattleshipMove> = {
  encode(m) {
    if (m.type === "commit") return { type: "commit", root: toHex(m.root) };
    if (m.type === "shoot") return { type: "shoot", cell: m.cell };
    return {
      type: "reveal",
      cell: m.cell,
      isShip: m.isShip,
      salt: toHex(m.salt),
      proof: m.proof.map(toHex),
    };
  },
  decode(j) {
    const o = j as {
      type: string;
      root?: string;
      cell?: number;
      isShip?: boolean;
      salt?: string;
      proof?: string[];
    };
    if (o.type === "commit") return { type: "commit", root: fromHex(o.root!) };
    if (o.type === "shoot") return { type: "shoot", cell: o.cell! };
    if (o.type === "reveal")
      return {
        type: "reveal",
        cell: o.cell!,
        isShip: o.isShip!,
        salt: fromHex(o.salt!),
        proof: (o.proof ?? []).map(fromHex),
      };
    throw new Error(`unknown battleship move: ${o.type}`);
  },
};
