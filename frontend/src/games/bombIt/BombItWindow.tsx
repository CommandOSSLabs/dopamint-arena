import { usePvpBombIt, type PvpBombIt } from "./usePvpBombIt";
import { BombLobby } from "./components/BombLobby";
import { BombBoard } from "./components/BombBoard";
import { BOMB_BTN, BOMB_IT_STYLE } from "./bombItTheme";
import { createArenaWindow } from "../_shared/arenaWindow";
import "./bomb-it.css";

/** Bomb It: PvP (human-vs-human over a shared tunnel); Play joins the relay queue. */
export const BombItWindow = createArenaWindow<PvpBombIt>({
  game: "bomb-it",
  usePvp: usePvpBombIt,
  Lobby: BombLobby,
  screen: {
    style: BOMB_IT_STYLE,
    rootClass: "bomb-lobby bomb-lobby--center sketch",
    cardClass:
      "bomb-lobby__card bomb-lobby__card--compact sketch-stroke sketch-panel",
    backBtnClass: `${BOMB_BTN} bomb-cta bomb-cta--full sketch-btn sketch-btn--ghost`,
  },
  matchingTitle: "Finding match",
  renderPvpBoard: (pvp, onPlayAgain) => (
    <BombBoard
      view={pvp.view!}
      winner={pvp.winner}
      role={pvp.role}
      stake={pvp.stake}
      auto={pvp.auto}
      onToggleAuto={pvp.toggleAuto}
      onAction={pvp.queueAction}
      onPlayAgain={onPlayAgain}
      onBack={onPlayAgain}
    />
  ),
});
