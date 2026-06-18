import { register } from "../registry";
import { TicTacToeWindow } from "./TicTacToeWindow";

// Unified Tic-Tac-Toe & Caro (3x3 and 15x15) with Bot, Auto-play, and PvP Online modes.
register({
  id: "tic-tac-toe",
  name: "Tic Tac Toe & Caro",
  icon: "⭕",
  image: "/games/caro.png",
  Window: TicTacToeWindow,
});
