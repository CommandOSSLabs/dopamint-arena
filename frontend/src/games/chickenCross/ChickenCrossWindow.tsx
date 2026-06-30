import { usePvpChickenCross, type PvpChickenCross } from "./usePvpChickenCross";
import { CrossLobby } from "./components/CrossLobby";
import { CrossBoard } from "./components/CrossBoard";
import { CROSS_BTN, CROSS_STYLE } from "./crossTheme";
import { createArenaWindow } from "../_shared/arenaWindow";
import "./cross.css";

/** Chicken Cross: PvP (two humans race over a shared tunnel); Play joins the relay queue. */
export const ChickenCrossWindow = createArenaWindow<PvpChickenCross>({
  game: "chicken-cross",
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
