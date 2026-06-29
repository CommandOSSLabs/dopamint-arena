/**
 * Adapter that lets the existing ttt mini-app (App.tsx / GameScene, which consume `BotGameView`)
 * drive its bot-vs-bot mode through the SHARED solo session (`useTttSession`) when the worker flag
 * is on — without rewriting the mini-app UI. The DEFAULT (legacy) path is the bespoke `useBotGame`,
 * untouched, so the rich on-chain trail / games-per-tunnel / draws UI keep working. Under
 * `?engine=worker` the bot-vs-bot session runs in the worker `SoloEngine`; fields the worker doesn't
 * surface (tx digests, settled-tunnel history, the games-per-tunnel control, the separate draw
 * tally) are stubbed/disabled here — the worker path is the A/B-tested showcase, not the funding UI.
 *
 * Bound once at module load (rules-of-hooks): one of two hooks, stable per session.
 */
import { useBotGame, type Difficulty, type BotGameView, type BotPhase } from "./app/hooks/useBotGame";
import { useTttSession } from "./useTttSession";
import { winnerToNum } from "./tttSoloCore";
import { TTT_STAKE } from "./tttSoloSpec";
import type { SessionStatus } from "../_shared/soloSessionHook";
import { engineEnabled } from "@/engine/flag";

const EMPTY_BOARD = Array(9).fill(0) as number[];
const STAKE = Number(TTT_STAKE);

/** Shared `SessionStatus` → the mini-app's `BotPhase` (settled ≙ done; matching/funding ≙ funding). */
function toPhase(s: SessionStatus): BotPhase {
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

/** Worker path (`?engine=worker`): the funded tunnel + per-duel loop run in the worker `SoloEngine`;
 *  this hook shapes its snapshot into the `BotGameView` the mini-app already renders. */
function useWorkerTttBotGame(windowId: string, _difficulty: Difficulty): BotGameView {
  const s = useTttSession(windowId);
  const v = s.view;
  const phase = toPhase(s.status);
  const winner = v ? winnerToNum(v.winner) : 0;
  const setAuto = (on: boolean) => {
    if (on !== s.auto) s.toggleAuto();
  };
  return {
    board: v ? v.board : EMPTY_BOARD,
    turn: v ? v.turn : "A",
    winner,
    phase,
    error: s.error,
    // Worker doesn't surface per-tx digests / settled-tunnel history — the on-chain trail UI hides.
    digests: {},
    tunnels: [],
    balances: {
      x: v ? BigInt(Math.trunc(v.balanceA)) : 0n,
      o: v ? BigInt(Math.trunc(v.balanceB)) : 0n,
    },
    // Shared session tallies wins only (draws are "no tally"), so draws render as 0 on this path.
    score: { x: s.score.you, o: s.score.foe, draws: 0 },
    auto: s.auto,
    setAuto,
    // Manual play: your (X/seat-A) turn while not autopiloting and the game is live.
    myTurn: !s.auto && phase === "playing" && !!v && v.winner === null && v.turn === "A",
    playCell: (cell: number) => s.playCell(cell),
    rebalancing: false,
    // The per-tunnel game count is fixed in the spec on this path — show it, but the selector no-ops.
    maxGames: v ? v.maxGames : 0,
    currentGame: v ? v.gamesPlayed + 1 : 0,
    balancesLoaded: true,
    setMaxGames: () => {},
    fund: () => {},
    rebalance: () => {},
    refresh: async () => null,
    resetScore: () => {},
    newGame: () => s.reset(),
    startAuto: () => s.start(STAKE),
    stopAuto: () => s.reset(),
    paused: false,
    pause: () => s.pause(),
    resume: () => s.resume(),
  };
}

/** Default (legacy) path: the bespoke main-thread bot-vs-bot session, untouched. */
function useLegacyTttBotGame(_windowId: string, difficulty: Difficulty): BotGameView {
  return useBotGame(difficulty);
}

/** `?engine=worker` routes ttt bot-vs-bot through the shared worker `SoloEngine`; default keeps the
 *  bespoke `useBotGame`. Selected once at module load (rules-of-hooks: a stable hook per session). */
export const useTttBotGame: (
  windowId: string,
  difficulty: Difficulty,
) => BotGameView = engineEnabled() ? useWorkerTttBotGame : useLegacyTttBotGame;
