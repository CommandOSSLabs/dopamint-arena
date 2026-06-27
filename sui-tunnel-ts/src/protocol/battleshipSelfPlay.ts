/**
 * Self-play driver: turns two known fleets into a stream of protocol moves. The
 * protocol holds only public state, so it cannot produce commit/answer/reveal
 * moves (those need the secret board). In vs-bot mode one process owns BOTH
 * fleets, so this driver answers shots truthfully and pipelines the return shot
 * on a miss (a hit keeps the shooter firing). Shot choice is a deterministic
 * random open cell — smart targeting is a frontend concern. Used by tests/bench.
 */
import { computeCommitment } from "../core/commitment";
import { otherParty, Party } from "./Protocol";
import {
  BattleshipMove,
  BattleshipProtocol,
  BattleshipState,
} from "./battleship";
import {
  BATTLESHIP_CELL_COUNT,
  placeFleetRandom,
  placementsToBoard,
} from "./battleshipFleet";

/** A player's secret board + salt + the single board-hash commitment. */
export interface FleetSecret {
  board: Uint8Array;
  salt: Uint8Array;
  commitment: Uint8Array;
}

export function makeFleetSecret(
  board: Uint8Array,
  salt: Uint8Array,
): FleetSecret {
  return { board, salt, commitment: computeCommitment(board, salt) };
}

export function randomFleetSecret(rng: () => number): FleetSecret {
  const board = placementsToBoard(placeFleetRandom(rng));
  const salt = new Uint8Array(16);
  for (let i = 0; i < salt.length; i++) salt[i] = Math.floor(rng() * 256);
  return makeFleetSecret(board, salt);
}

export interface DrivenMove {
  move: BattleshipMove;
  by: Party;
}

/** Cells `shooter` has not yet fired at (shots land on the opponent's board). */
function openCellsFor(state: BattleshipState, shooter: Party): number[] {
  const fired = new Set(
    (shooter === "A" ? state.shotsAtB : state.shotsAtA).map((s) => s.cell),
  );
  const open: number[] = [];
  for (let cell = 0; cell < BATTLESHIP_CELL_COUNT; cell++)
    if (!fired.has(cell)) open.push(cell);
  return open;
}

function pickOpenCell(
  state: BattleshipState,
  shooter: Party,
  rng: () => number,
): number | null {
  const open = openCellsFor(state, shooter);
  if (open.length === 0) return null;
  return open[Math.min(open.length - 1, Math.floor(rng() * open.length))];
}

export function nextMove(
  state: BattleshipState,
  secrets: { A: FleetSecret; B: FleetSecret },
  rng: () => number,
): DrivenMove | null {
  if (state.phase === "over") return null;

  if (state.phase === "awaitingCommits") {
    if (state.commitA === null)
      return {
        by: "A",
        move: { kind: "commit", commitment: secrets.A.commitment },
      };
    if (state.commitB === null)
      return {
        by: "B",
        move: { kind: "commit", commitment: secrets.B.commitment },
      };
    return null;
  }

  if (state.phase === "revealBoards") {
    if (!state.revealedA)
      return {
        by: "A",
        move: {
          kind: "reveal_board",
          board: secrets.A.board,
          salt: secrets.A.salt,
        },
      };
    if (!state.revealedB)
      return {
        by: "B",
        move: {
          kind: "reveal_board",
          board: secrets.B.board,
          salt: secrets.B.salt,
        },
      };
    return null;
  }

  // phase === "playing"
  if (state.pendingShot) {
    const defender = otherParty(state.pendingShot.by);
    const isHit = secrets[defender].board[state.pendingShot.cell] === 1;
    if (isHit) {
      return { by: defender, move: { kind: "answer", isHit: true } };
    }
    // miss -> the defender takes the turn and pipelines its own shot if it can
    const next = pickOpenCell(state, defender, rng);
    return {
      by: defender,
      move:
        next === null
          ? { kind: "answer", isHit: false }
          : { kind: "answer", isHit: false, next },
    };
  }

  // no pending shot: the player whose turn it is fires (opening, or after a hit)
  const cell = pickOpenCell(state, state.turn, rng);
  if (cell === null) return null;
  return { by: state.turn, move: { kind: "shoot", cell } };
}

export function playToCompletion(
  protocol: BattleshipProtocol,
  initial: BattleshipState,
  secrets: { A: FleetSecret; B: FleetSecret },
  rng: () => number,
  maxMoves = 5000,
): BattleshipState {
  let state = initial;
  for (let i = 0; i < maxMoves; i++) {
    const driven = nextMove(state, secrets, rng);
    if (!driven) return state;
    state = protocol.applyMove(state, driven.move, driven.by);
  }
  throw new Error("game did not terminate within maxMoves");
}
