import { usePvpBombIt, type PvpBombIt } from "./usePvpBombIt";
import { useBombItSession, type BombItSession } from "./useBombItSession";
import { BombLobby } from "./components/BombLobby";
import { BombBoard } from "./components/BombBoard";
import { BOMB_BTN, BOMB_IT_STYLE } from "./bombItTheme";
import { createArenaWindow } from "../_shared/arenaWindow";
import "./bomb-it.css";

/** Bomb It: pick Solo (bot-vs-bot self-play) or PvP (human-vs-human over a shared tunnel). */
export const BombItWindow = createArenaWindow<BombItSession, PvpBombIt>({
  game: "bomb-it",
  useSolo: useBombItSession,
  usePvp: usePvpBombIt,
  Lobby: BombLobby,
  screen: {
    style: BOMB_IT_STYLE,
    rootClass: "bomb-lobby sketch",
    cardClass:
      "bomb-lobby__card bomb-lobby__card--compact sketch-stroke sketch-panel",
    backBtnClass: `${BOMB_BTN} bomb-cta bomb-cta--full sketch-btn sketch-btn--ghost`,
  },
  matchingTitle: "Finding match",
  errorEyebrow: false,
  renderSoloBoard: (solo, onPlayAgain) => (
    <BombBoard
      view={solo.view!}
      winner={solo.view!.winner}
      role="A"
      stake={solo.stake}
      auto={solo.auto}
      onToggleAuto={solo.toggleAuto}
      onAction={solo.queueAction}
      onPlayAgain={onPlayAgain}
      score={solo.score}
      gamesPlayed={solo.gamesPlayed}
      onSettle={solo.status === "playing" ? solo.settleNow : undefined}
    />
  ),
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
    />
  ),
});
