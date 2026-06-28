/**
 * Self-play driver (v2): two known fleets → a stream of SDK battleship.v2 moves.
 * The protocol holds only public state, so this driver (which owns BOTH fleets in
 * vs-bot mode) answers shots truthfully and reveals each board at game end. It
 * answers BARE (no pipelined `next`) so the session hook can gate the human's own
 * shot exactly as in v1; the bench bot (agent kit) pipelines separately. Shot
 * choice uses the smart bot (`pickShot`).
 */
import {
  BattleshipProtocol,
  type BattleshipMove,
  type BattleshipState,
} from "sui-tunnel-ts/protocol/battleship";
import { computeCommitment } from "sui-tunnel-ts/core/commitment";
import { otherParty, type Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  BOT_CONFIGS,
  type BotDifficulty,
  DEFAULT_BOT_DIFFICULTY,
  pickShot,
} from "./bot";
import { CELL_COUNT, placeFleetRandom, placementsToBoard } from "./fleet";

/** A player's secret board + single salt + the board-hash commitment. */
export interface FleetSecret {
  board: Uint8Array;
  salt: Uint8Array;
  commitment: Uint8Array;
}

/** 16 cryptographically-secure random bytes (browser/Node CSPRNG). */
export function secureSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(16));
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

export function nextMove(
  state: BattleshipState,
  secrets: { A: FleetSecret; B: FleetSecret },
  rng: () => number,
  difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
): DrivenMove | null {
  if (state.phase === "over") return null;

  if (state.phase === "awaitingCommits") {
    if (state.commitA === null)
      return { by: "A", move: { kind: "commit", commitment: secrets.A.commitment } };
    if (state.commitB === null)
      return { by: "B", move: { kind: "commit", commitment: secrets.B.commitment } };
    return null;
  }

  if (state.phase === "revealBoards") {
    if (!state.revealedA)
      return {
        by: "A",
        move: { kind: "reveal_board", board: secrets.A.board, salt: secrets.A.salt },
      };
    if (!state.revealedB)
      return {
        by: "B",
        move: { kind: "reveal_board", board: secrets.B.board, salt: secrets.B.salt },
      };
    return null;
  }

  // phase === "playing"
  if (state.pendingShot) {
    const defender = otherParty(state.pendingShot.by);
    const isHit = secrets[defender].board[state.pendingShot.cell] === 1;
    // Bare answer (no pipelined `next`): the next shooter fires as its own move,
    // preserving v1's per-shot cadence and the session's human-shot gating.
    return { by: defender, move: { kind: "answer", isHit } };
  }

  return {
    by: state.turn,
    move: {
      kind: "shoot",
      cell: pickShot(state, state.turn, rng, BOT_CONFIGS[difficulty]),
    },
  };
}

export function playToCompletion(
  protocol: BattleshipProtocol,
  initial: BattleshipState,
  secrets: { A: FleetSecret; B: FleetSecret },
  rng: () => number,
  difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
  maxMoves = 5000,
): BattleshipState {
  let state = initial;
  for (let i = 0; i < maxMoves; i++) {
    const driven = nextMove(state, secrets, rng, difficulty);
    if (!driven) return state;
    state = protocol.applyMove(state, driven.move, driven.by);
  }
  throw new Error("game did not terminate within maxMoves");
}
