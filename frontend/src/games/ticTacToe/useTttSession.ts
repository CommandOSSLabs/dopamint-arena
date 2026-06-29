/**
 * Tic-Tac-Toe self-play (bot-vs-bot) session, on the SHARED solo machinery — the same pattern
 * bomb-it / chicken-cross use (`useBombItSession`), not ttt's bespoke `useBotGame`. The legacy
 * main-thread path is the generic `createSoloSessionHook`; the worker path is the generic
 * `useGameSolo` + `engineClient`. Both lanes reuse the shared pieces from `tttSoloCore` /
 * `tttSoloSpec` (protocol wrapper, kit bots, stepper, view) so behaviour is identical by
 * construction — no ttt-specific session/funding/settle logic is written here.
 */
import type { MultiGameTicTacToeMove } from "@ttt/shared/ttt/multiGameProtocol";
import {
  createSoloSessionHook,
  type SoloSession,
  type SessionStatus,
} from "../_shared/soloSessionHook";
import {
  type SoloTttState,
  type TttView,
  type TttResult,
  deriveTttView,
  tttSessionResult,
  stepMultiGameTtt,
  kickoffNextGameTtt,
} from "./tttSoloCore";
import {
  SoloTicTacToeProtocol,
  makeTttBots,
  TTT_GAMES_PER_TUNNEL,
  TTT_STAKE,
  TTT_MANUAL_STEP_MS,
  TTT_REMATCH_MS,
  type TttBots,
} from "./tttSoloSpec";
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameSolo } from "@/engine/react/useGameSolo";
import type { MatchSnapshot } from "@/engine/engineApi";

export type { SessionStatus };

/** Main-thread path (default): the shared out-of-React self-play session, parameterised for ttt. */
const useSoloSession = createSoloSessionHook<
  SoloTttState,
  MultiGameTicTacToeMove,
  number,
  TttView,
  TttResult,
  SoloTicTacToeProtocol,
  TttBots
>({
  game: "tictactoe",
  settleLabel: "ticTacToe",
  minStake: TTT_STAKE,
  participants: ["ttt-x", "ttt-o"],
  rematchMs: TTT_REMATCH_MS,
  // Turn-based: manual play co-signs one tick per this so a takeover move is readable; autopilot
  // still batches (the throughput showcase).
  manualStepMs: TTT_MANUAL_STEP_MS,
  makeProtocol: (_tunnelId, stakePerGame) =>
    new SoloTicTacToeProtocol(TTT_GAMES_PER_TUNNEL, stakePerGame),
  makeBots: makeTttBots,
  deriveView: deriveTttView,
  sessionResult: tttSessionResult,
  // The take-over seat is always seat A (X); its queued cell drives A's move, else A's bot fills in.
  stepWith: (protocol, tunnel, bots, take) =>
    stepMultiGameTtt(
      protocol,
      tunnel,
      bots,
      take ? { seat: "A", getCell: () => take() } : null,
    ),
  kickoffNextGame: kickoffNextGameTtt,
});

/** Reactive surface for a ttt self-play session; `queueIntent` is renamed to the domain `playCell`. */
export interface TttSession
  extends Omit<SoloSession<number, TttView, TttResult>, "queueIntent"> {
  /** Place your seat-A (X) mark at this cell on the next manual tick (consumed once). */
  playCell: (cell: number) => void;
}

/** Main-thread path (default). */
function useLegacyTttSession(windowId: string): TttSession {
  const { queueIntent, ...rest } = useSoloSession(windowId);
  return { ...rest, playCell: queueIntent };
}

/** Worker path (`?engine=worker`): the funded tunnel + per-duel loop run in a dedicated Web Worker
 *  (`SoloEngine`); this hook only renders snapshots and forwards commands via `engineClient`. */
function useWorkerTttSession(windowId: string): TttSession {
  const snap = useGameSolo(windowId) as MatchSnapshot<TttView>;
  // The solo lane never emits "matching" (PvP-only); fold it into "funding" so the status narrows
  // to the shared `SessionStatus`.
  const status: SessionStatus =
    snap.status === "matching" ? "funding" : snap.status;
  return {
    status,
    view: snap.view,
    result: (snap.result ?? null) as TttResult | null,
    stake: snap.stake,
    error: snap.error,
    auto: snap.auto,
    score: snap.score ?? { you: 0, foe: 0 },
    gamesPlayed: snap.gamesPlayed ?? 0,
    start: (stake) => engineClient.findSolo(windowId, "tictactoe", stake),
    reset: () => engineClient.reset(windowId),
    playCell: (cell) => engineClient.submitInput(windowId, cell),
    toggleAuto: () => engineClient.setAuto(windowId, !snap.auto),
    settleNow: () => engineClient.settleSolo(windowId),
    pause: () => engineClient.setPaused(windowId, true),
    resume: () => engineClient.setPaused(windowId, false),
  };
}

/** `?engine=worker` selects the worker path; default keeps the main-thread path. Bound once at
 *  module load so the hook identity is stable per session (rules-of-hooks). */
export const useTttSession: (windowId: string) => TttSession = engineEnabled()
  ? useWorkerTttSession
  : useLegacyTttSession;
