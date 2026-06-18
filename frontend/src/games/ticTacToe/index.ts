import { register } from "../registry";
import { TicTacToePvpWindow } from "./TicTacToePvpWindow";

// Tic Tac Toe is the real two-player PvP game: matchmaking + relay co-sign + on-chain stakes.
register({
  id: "tic-tac-toe",
  name: "Tic Tac Toe",
  icon: "⭕",
  image: "/games/caro.png",
  Window: TicTacToePvpWindow,
});
