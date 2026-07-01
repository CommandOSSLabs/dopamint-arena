import { register } from "../registry";
import { TicTacToeWindow } from "./TicTacToeWindow";
import {
  TIC_TAC_TOE_ARENA_GAME_ID,
  CARO_ARENA_GAME_ID,
} from "./app/hooks/usePvpTicTacToe";

// Unified Tic-Tac-Toe & Caro (3x3 and 15x15) with Bot, Auto-play, and PvP Online modes.
register({
  id: "tic-tac-toe",
  name: "Tic Tac Toe & Caro",
  description: "3×3 or 15×15 Caro — bot, auto-play, or live PvP.",
  icon: "⭕",
  image: "/games/caro.png",
  Window: TicTacToeWindow,
  // One window hosts both protocols (`caro.series.v2` + `tic_tac_toe.series.v2`, both fleet-wired with
  // verified move-wire goldens). Caro is FIRST = the default variant the window opens in, so the
  // batched entry funds only caro for this window (the consumer in usePvpTicTacToe is variant-keyed;
  // toggling to 3×3 ttt uses its own entry if allocated). caro board pinned 15.
  arenaGameId: [CARO_ARENA_GAME_ID, TIC_TAC_TOE_ARENA_GAME_ID],
});
