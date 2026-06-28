/**
 * PvP reactive driver (v2). A seat holds only its OWN fleet, so the moves it can
 * make from public state are: its ordered `commit`, the `answer` it owes when the
 * opponent shoots it, and the terminal `reveal_board` at game end. Those are driven
 * automatically (call {@link proposeDue} from `onConfirmed`); the seat's own `shoot`
 * is the one human-driven move. Answers are BARE (the human fires their own next
 * shot). See ADR 0003.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type {
  BattleshipMove,
  BattleshipState,
} from "sui-tunnel-ts/protocol/battleship";
import type { FleetSecret } from "./selfPlay";

type BattleshipTunnel = DistributedTunnel<BattleshipState, BattleshipMove>;

/** The truthful hit/miss answer for the cell of this seat's own fleet. */
export function answerMove(secret: FleetSecret, cell: number): BattleshipMove {
  return { kind: "answer", isHit: secret.board[cell] === 1 };
}

/**
 * If this seat owes a non-shot move in the current confirmed state, propose it and
 * return true; else false. Handles the ordered opening commit (A then B), the
 * defender's `answer` to an incoming shot, and the terminal `reveal_board`. Shots
 * are left to the player. Safe to call from `onConfirmed`.
 */
export function proposeDue(
  dt: BattleshipTunnel,
  role: Party,
  secret: FleetSecret,
): boolean {
  const st = dt.state;
  if (st.phase === "over") return false;

  if (st.phase === "awaitingCommits") {
    const myCommit = role === "A" ? st.commitA : st.commitB;
    if (myCommit !== null) return false;
    const myTurnToCommit =
      role === "A" ? st.commitA === null : st.commitA !== null;
    if (!myTurnToCommit) return false;
    dt.propose({ kind: "commit", commitment: secret.commitment }, 0n);
    return true;
  }

  if (st.phase === "revealBoards") {
    const myRevealed = role === "A" ? st.revealedA : st.revealedB;
    if (myRevealed) return false;
    // Reveals are ordered A-then-B (like commits) so the two seats never propose
    // at the same nonce — B reveals only once A's reveal is confirmed.
    const myTurnToReveal = role === "A" ? !st.revealedA : st.revealedA;
    if (!myTurnToReveal) return false;
    dt.propose(
      { kind: "reveal_board", board: secret.board, salt: secret.salt },
      0n,
    );
    return true;
  }

  // Defender answers the cell the opponent just fired at us.
  if (st.phase === "playing" && st.pendingShot && st.pendingShot.by !== role) {
    dt.propose(answerMove(secret, st.pendingShot.cell), 0n);
    return true;
  }
  return false;
}
