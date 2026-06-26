import { usePvpChickenCross, type PvpChickenCross } from "./usePvpChickenCross";
import {
  useChickenCrossSession,
  type ChickenCrossSession,
} from "./useChickenCrossSession";
import { CrossLobby } from "./components/CrossLobby";
import { CrossBoard } from "./components/CrossBoard";
import { CROSS_BTN, CROSS_STYLE } from "./crossTheme";
import { createArenaWindow } from "../_shared/arenaWindow";
import "./cross.css";

/** Chicken Cross: pick Solo (bot-vs-bot self-play) or PvP (two humans race over a shared tunnel). */
export const ChickenCrossWindow = createArenaWindow<
  ChickenCrossSession,
  PvpChickenCross
>({
  game: "chicken-cross",
  useSolo: useChickenCrossSession,
  usePvp: usePvpChickenCross,
  Lobby: CrossLobby,
  screen: {
    style: CROSS_STYLE,
    rootClass: "cross-lobby sketch",
    cardClass:
      "cross-lobby__card cross-lobby__card--compact sketch-stroke sketch-panel",
    backBtnClass: `${CROSS_BTN} cross-cta cross-cta--full sketch-btn sketch-btn--ghost`,
  },
  matchingTitle: "Finding…",
  errorEyebrow: true,
  renderSoloBoard: (solo, onPlayAgain) => (
    <CrossBoard
      view={solo.view!}
      winner={solo.view!.winner}
      role="A"
      stake={solo.stake}
      seed={solo.view!.seed}
      done={solo.status === "settled"}
      auto={solo.auto}
      onToggleAuto={solo.toggleAuto}
      onDir={solo.setDir}
      onPlayAgain={onPlayAgain}
      score={solo.score}
      gamesPlayed={solo.gamesPlayed}
      onSettle={solo.status === "playing" ? solo.settleNow : undefined}
      onBack={onPlayAgain}
    />
  ),
  renderPvpBoard: (pvp, onPlayAgain) => (
    <CrossBoard
      view={pvp.view!}
      winner={pvp.winner}
      role={pvp.role}
      stake={pvp.stake}
      seed={pvp.view!.seed}
      done={pvp.status === "settled"}
      auto={pvp.auto}
      onToggleAuto={pvp.toggleAuto}
      onDir={pvp.setDir}
      onPlayAgain={onPlayAgain}
      onBack={onPlayAgain}
    />
  ),
});
