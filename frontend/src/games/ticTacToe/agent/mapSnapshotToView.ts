// Pure projection: SessionSnapshot<MultiGameTicTacToeState> + React-local extras
// → the game/phase portion of PvpTttView.
//
// React-local fields (address, balance, score, games, digests.create/deposit) are
// NOT owned by the session; callers pass them as `extras` and this function threads
// them into the returned object verbatim.  The session owns only the off-chain
// state — phase, board, balances, terminal — plus the close digest.
import type { SessionSnapshot } from "@/agent/session/pvpGameSession";
import type { MultiGameTicTacToeState } from "@ttt/shared/ttt/multiGameProtocol";
import type { CaroState } from "@ttt/shared/caro/protocol";
import type {
  PvpPhase,
  PvpTttView,
  GameResult,
  Variant,
} from "../app/hooks/usePvpTicTacToe";

/**
 * React-local state threaded through from the hook.
 * - address/balance: dapp-kit wallet (never owned by the session).
 * - score/games: cumulative tallies accumulated by the hook on each winner transition.
 * - digests.create/deposit: from on-chain open/deposit steps.
 * - role: "A" | "B" | null (known after match.found, before any state arrives).
 * - auto: current auto-play toggle value.
 * - variant/boardSize: fixed per hook invocation.
 * - closeDigest: from snapshot.digest (provided separately so the caller can extract it).
 */
export interface SnapshotExtras {
  address: string;
  balance: bigint;
  role: "A" | "B" | null;
  score: { x: number; o: number; draws: number };
  games: GameResult[];
  digests: { create?: string; deposit?: string };
  auto: boolean;
  variant: Variant;
  boardSize: number;
  // Imperative callbacks passed through unchanged.
  queue: () => void;
  play: (cell: number) => void;
  next: () => void;
  stop: () => void;
  setAuto: (on: boolean) => void;
  leave: () => void;
  requeue: () => void;
}

/**
 * Map a SessionSnapshot<MultiGameTicTacToeState> plus React-local extras into the
 * full PvpTttView surface.  This is a pure function of its arguments — no React, no
 * IO, trivially unit-testable.
 *
 * SessionPhase "opponent-abandoned" is collapsed to "error" so PvpScene never
 * encounters an unknown phase value (PvpPhase doesn't include it).
 */
export function mapSnapshotToView(
  snapshot: Readonly<SessionSnapshot<MultiGameTicTacToeState>>,
  extras: SnapshotExtras,
): PvpTttView {
  const { state, phase: rawPhase, error, terminal } = snapshot;
  const inner = state?.inner ?? null;

  // Collapse session-only phase variants to the nearest PvpPhase equivalent.
  const phase: PvpPhase =
    rawPhase === "opponent-abandoned" ? "error" : (rawPhase as PvpPhase);

  const { role } = extras;
  const myMark: 0 | 1 | 2 = role === "A" ? 1 : role === "B" ? 2 : 0;

  const winner = inner ? inner.winner : 0;
  const isMyTurn =
    !!inner && inner.winner === 0 && inner.turn === role && phase === "playing";

  // close digest comes from snapshot; create/deposit come from React-local extras.
  const digests: { create?: string; deposit?: string; close?: string } = {
    ...extras.digests,
    ...(snapshot.digest ? { close: snapshot.digest } : {}),
  };

  return {
    phase,
    error: error ?? null,
    role,
    variant: extras.variant,
    board: inner ? inner.board : [],
    size: inner
      ? ((inner as Partial<CaroState>).size ?? 3)
      : extras.variant === "caro"
        ? extras.boardSize
        : 3,
    lastMove: inner ? ((inner as Partial<CaroState>).lastMove ?? -1) : -1,
    turn: inner ? inner.turn : null,
    winner,
    myMark,
    isMyTurn,
    innerOver: !!inner && inner.winner !== 0,
    terminal,
    score: extras.score,
    games: extras.games,
    currentGame: state ? state.gamesPlayed + 1 : 0,
    auto: extras.auto,
    address: extras.address,
    balance: extras.balance,
    digests,
    queue: extras.queue,
    play: extras.play,
    next: extras.next,
    stop: extras.stop,
    setAuto: extras.setAuto,
    leave: extras.leave,
    requeue: extras.requeue,
  };
}
