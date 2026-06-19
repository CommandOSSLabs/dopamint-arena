/**
 * Self-play driver: turns two known fleets into a stream of protocol moves.
 *
 * The protocol holds only public state, so it cannot produce `commit`/`reveal`
 * moves (those need the secret fleet). In vs-bot mode one process owns BOTH
 * fleets, so this driver computes the next move for whichever seat must act —
 * committing roots, answering shots with truthful reveals + Merkle proofs, and
 * firing a simple hunt/target shot. The session hook (M1) calls this on a timer
 * and feeds each move to `OffchainTunnel.step`. See ADR 0003.
 */

import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { otherParty } from "sui-tunnel-ts/protocol/Protocol";
import {
  BattleshipProtocol,
  type BattleshipMove,
  type BattleshipState,
  type ShotResult,
} from "../protocol/battleship";
import {
  CELL_COUNT,
  cellAt,
  colOf,
  inBounds,
  placeFleetRandom,
  placementsToBoard,
  rowOf,
} from "./fleet";
import {
  type BoardCommitment,
  SALT_BYTES,
  commitBoard,
  proveCell,
} from "./merkle";

/** A player's secret fleet plus its precomputed commitment. */
export interface FleetSecret {
  /** 100-cell 0/1 board. */
  board: Uint8Array;
  /** Per-cell salts (100 × {@link SALT_BYTES} bytes). */
  salts: Uint8Array[];
  commitment: BoardCommitment;
}

export function makeFleetSecret(
  board: Uint8Array,
  salts: Uint8Array[],
): FleetSecret {
  return { board, salts, commitment: commitBoard(board, salts) };
}

/** A randomly-placed fleet with rng-derived salts — for the bot seat and tests. */
export function randomFleetSecret(rng: () => number): FleetSecret {
  const board = placementsToBoard(placeFleetRandom(rng));
  const salts = Array.from({ length: CELL_COUNT }, () => {
    const s = new Uint8Array(SALT_BYTES);
    for (let i = 0; i < SALT_BYTES; i++) s[i] = Math.floor(rng() * 256);
    return s;
  });
  return makeFleetSecret(board, salts);
}

export interface DrivenMove {
  move: BattleshipMove;
  by: Party;
}

function shotsAtBoard(state: BattleshipState, defender: Party): ShotResult[] {
  return defender === "A" ? state.shotsAtA : state.shotsAtB;
}

function orthoNeighbors(cell: number): number[] {
  const r = rowOf(cell);
  const c = colOf(cell);
  const out: number[] = [];
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const) {
    if (inBounds(r + dr, c + dc)) out.push(cellAt(r + dr, c + dc));
  }
  return out;
}

/**
 * Hunt/target shot: if a prior hit on the defender has unexplored neighbors,
 * fire there (chase the ship); otherwise fire a random unfired cell. Makes the
 * bot look like it's playing rather than spraying.
 */
function pickShot(
  state: BattleshipState,
  shooter: Party,
  rng: () => number,
): number {
  const defender = otherParty(shooter);
  const shots = shotsAtBoard(state, defender);
  const fired = new Set(shots.map((s) => s.cell));

  const targets: number[] = [];
  for (const s of shots) {
    if (!s.isHit) continue;
    for (const n of orthoNeighbors(s.cell)) if (!fired.has(n)) targets.push(n);
  }
  const pool = targets.length > 0 ? targets : openCells(fired);
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

function openCells(fired: Set<number>): number[] {
  const out: number[] = [];
  for (let cell = 0; cell < CELL_COUNT; cell++)
    if (!fired.has(cell)) out.push(cell);
  return out;
}

/**
 * The next move for whichever seat must act, or null when the game is over.
 * `secrets` must hold both fleets (vs-bot runs both seats locally).
 */
export function nextMove(
  state: BattleshipState,
  secrets: { A: FleetSecret; B: FleetSecret },
  rng: () => number,
): DrivenMove | null {
  if (state.winner !== 0 || state.phase === "over") return null;

  if (state.phase === "awaitingCommits") {
    if (state.commitA === null) {
      return {
        move: { type: "commit", root: secrets.A.commitment.root },
        by: "A",
      };
    }
    if (state.commitB === null) {
      return {
        move: { type: "commit", root: secrets.B.commitment.root },
        by: "B",
      };
    }
    return null;
  }

  // phase === "playing"
  if (state.pendingShot) {
    const defender = otherParty(state.pendingShot.by);
    const cell = state.pendingShot.cell;
    const secret = secrets[defender];
    return {
      by: defender,
      move: {
        type: "reveal",
        cell,
        isShip: secret.board[cell] === 1,
        salt: secret.salts[cell],
        proof: proveCell(secret.commitment, cell),
      },
    };
  }

  return {
    by: state.turn,
    move: { type: "shoot", cell: pickShot(state, state.turn, rng) },
  };
}

/**
 * Play an entire game by feeding driver moves through the protocol. Returns the
 * terminal state. Throws if it fails to terminate within `maxMoves` (a bug
 * backstop — random play finishes in a few hundred moves).
 */
export function playToCompletion(
  protocol: BattleshipProtocol,
  initial: BattleshipState,
  secrets: { A: FleetSecret; B: FleetSecret },
  rng: () => number,
  maxMoves = 2000,
): BattleshipState {
  let state = initial;
  for (let i = 0; i < maxMoves; i++) {
    const driven = nextMove(state, secrets, rng);
    if (!driven) return state;
    state = protocol.applyMove(state, driven.move, driven.by);
  }
  throw new Error("game did not terminate within maxMoves");
}
