/**
 * PvP reactive driver. In a two-browser game each client holds only its OWN
 * fleet, so the moves a seat can make from the public state are: its ordered
 * `commit`, and the `reveal` it owes whenever the opponent shoots it. Those are
 * driven automatically (call {@link proposeDue} from `onConfirmed`); the seat's
 * own `shoot` is the one human-driven move. See ADR 0003.
 */

import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type { BattleshipMove, BattleshipState } from "../protocol/battleship";
import type { FleetSecret } from "./selfPlay";
import { proveCell } from "./merkle";

type BattleshipTunnel = DistributedTunnel<BattleshipState, BattleshipMove>;

/**
 * Whether `role` may propose a `shoot` at `cell` right now. Gates on the CONFIRMED `state` (its turn,
 * no shot awaiting a reveal, the game live, the cell unfired) AND on `hasPending`: a proposal already
 * awaiting its ACK. The pending guard is load-bearing — the confirmed state lags an in-flight
 * proposal, so a re-seated pending shoot after cold-load resume reads as "A's turn, nothing pending",
 * and gating on the state alone would propose a second shoot and throw "a proposal is already awaiting
 * ACK". Callers pass `hasPending` as `tunnel.displayState !== tunnel.state`.
 */
export function canFireShot(
  state: BattleshipState,
  role: Party,
  cell: number,
  hasPending: boolean,
): boolean {
  if (hasPending) return false;
  if (
    state.phase !== "playing" ||
    state.pendingShot ||
    state.turn !== role ||
    state.winner !== 0
  )
    return false;
  const atOpponent = role === "A" ? state.shotsAtB : state.shotsAtA;
  return !atOpponent.some((s) => s.cell === cell);
}

/** The truthful reveal for a cell of this seat's own fleet, with its Merkle proof. */
export function revealMove(secret: FleetSecret, cell: number): BattleshipMove {
  return {
    type: "reveal",
    cell,
    isShip: secret.board[cell] === 1,
    salt: secret.salts[cell],
    proof: proveCell(secret.commitment, cell),
  };
}

/**
 * If this seat owes a non-shot move in the current confirmed state, propose it
 * and return true; otherwise return false. Handles the ordered opening commit
 * (A then B) and the defender's reveal of an incoming shot. Shots are left to
 * the player. Safe to call from `onConfirmed` (no proposal is pending then).
 */
export function proposeDue(
  dt: BattleshipTunnel,
  role: Party,
  secret: FleetSecret,
): boolean {
  const st = dt.state;
  if (st.winner !== 0) return false;

  if (st.phase === "awaitingCommits") {
    const myCommit = role === "A" ? st.commitA : st.commitB;
    if (myCommit !== null) return false; // already committed
    // A commits first; B only once A has.
    const myTurnToCommit =
      role === "A" ? st.commitA === null : st.commitA !== null;
    if (!myTurnToCommit) return false;
    dt.propose({ type: "commit", root: secret.commitment.root }, 0n);
    return true;
  }

  // Defender reveals the cell the opponent just fired at us.
  if (st.phase === "playing" && st.pendingShot && st.pendingShot.by !== role) {
    dt.propose(revealMove(secret, st.pendingShot.cell), 0n);
    return true;
  }
  return false;
}
