/**
 * Adapter that lets the ttt mini-app (App.tsx / CaroScene, which consume `CaroBotGameView`) drive
 * caro's bot-vs-bot mode through the SHARED worker `SoloEngine` when the flag is on — the caro
 * sibling of `useTttBotGame`, and without rewriting the mini-app UI. The DEFAULT (legacy) path is
 * the bespoke main-thread `useCaroBotGame` (`app/hooks/useCaroBotGame`), untouched, so its rich
 * on-chain trail / games-per-tunnel / funding UI keep working. Under the worker path the session
 * runs in the worker; fields the worker doesn't surface (tx digests, settled-tunnel history, the
 * games-per-tunnel control, the draw tally) are stubbed/disabled — the worker path is the showcase,
 * not the funding UI.
 *
 * Bound once at module load (rules-of-hooks): one of two hooks, stable per session.
 */
import { useCaroBotGame as useLegacyCaroBotGame } from "./app/hooks/useCaroBotGame";
import type { CaroBotGameView } from "./app/hooks/useCaroBotGame";
import type { Difficulty, BotPhase } from "./app/hooks/useBotGame";
import { useGameSolo } from "@/engine/react/useGameSolo";
import { engineClient } from "@/engine/engineClient";
import { engineEnabled } from "@/engine/flag";
import { winnerToNum, type CaroView } from "./caroSoloCore";
import { CARO_BOARD_SIZE, CARO_STAKE } from "./caroSoloSpec";
import type { MatchSnapshot } from "@/engine/engineApi";

const STAKE = Number(CARO_STAKE);

/** Worker `EngineStatus` → the mini-app's `BotPhase` (settled ≙ done; matching/funding ≙ funding). */
function toPhase(s: MatchSnapshot["status"]): BotPhase {
  switch (s) {
    case "funding":
      return "funding";
    case "playing":
      return "playing";
    case "settling":
      return "settling";
    case "settled":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/** Worker path: the funded tunnel + per-duel loop run in the worker `SoloEngine`; this hook shapes
 *  its snapshot into the `CaroBotGameView` the mini-app already renders. */
function useWorkerCaroBotGame(
  windowId: string,
  _difficulty: Difficulty,
  _boardSize: number,
): CaroBotGameView {
  const snap = useGameSolo(windowId) as MatchSnapshot<CaroView>;
  const v = snap.view;
  const phase = toPhase(snap.status);
  const score = snap.score ?? { you: 0, foe: 0 };
  const emptyBoard = Array(CARO_BOARD_SIZE * CARO_BOARD_SIZE).fill(
    0,
  ) as number[];
  return {
    board: v ? v.board : emptyBoard,
    boardSize: v ? v.size : CARO_BOARD_SIZE,
    lastMove: v ? v.lastMove : -1,
    turn: v ? v.turn : "A",
    winner: v ? winnerToNum(v.winner) : 0,
    phase,
    error: snap.error,
    // Worker doesn't surface per-tx digests / settled-tunnel history — the on-chain trail UI hides.
    digests: {},
    tunnels: [],
    balances: {
      x: v ? BigInt(Math.trunc(v.balanceA)) : 0n,
      o: v ? BigInt(Math.trunc(v.balanceB)) : 0n,
    },
    // Shared session tallies wins only (draws are "no tally"), so draws render as 0 on this path.
    score: { x: score.you, o: score.foe, draws: 0 },
    auto: snap.auto,
    setAuto: (on: boolean) => {
      if (on !== snap.auto) engineClient.setAuto(windowId, !snap.auto);
    },
    // Manual play: your (X/seat-A) turn while not autopiloting and the game is live.
    myTurn:
      !snap.auto &&
      phase === "playing" &&
      !!v &&
      v.winner === null &&
      v.turn === "A",
    playCell: (cell: number) => engineClient.submitInput(windowId, cell),
    rebalancing: false,
    maxGames: v ? v.maxGames : 0,
    currentGame: v ? v.gamesPlayed + 1 : 0,
    balancesLoaded: true,
    // Funding controls are fixed/owned by the worker spec on this path — show, but no-op.
    setMaxGames: () => {},
    fund: () => {},
    rebalance: () => {},
    refresh: async () => null,
    resetScore: () => {},
    newGame: () => engineClient.reset(windowId),
    startAuto: (autoOn = true) => {
      engineClient.findSolo(windowId, "caro", STAKE);
      // Start in manual (you play X) when asked: drop autopilot once the session is up.
      if (autoOn === false) engineClient.setAuto(windowId, false);
    },
    stopAuto: () => engineClient.reset(windowId),
    paused: false,
    pause: () => engineClient.setPaused(windowId, true),
    resume: () => engineClient.setPaused(windowId, false),
  };
}

/** Default (legacy) path: the bespoke main-thread caro bot game, untouched (windowId unused). */
function useLegacyCaroBotGameAdapter(
  _windowId: string,
  difficulty: Difficulty,
  boardSize: number,
): CaroBotGameView {
  return useLegacyCaroBotGame(difficulty, boardSize);
}

/** The worker path routes caro bot-vs-bot through the shared `SoloEngine`; `?engine=legacy` keeps
 *  the bespoke hook. Selected once at module load (rules-of-hooks: a stable hook per session). */
export const useCaroBotGame: (
  windowId: string,
  difficulty: Difficulty,
  boardSize: number,
) => CaroBotGameView = engineEnabled()
  ? useWorkerCaroBotGame
  : useLegacyCaroBotGameAdapter;
