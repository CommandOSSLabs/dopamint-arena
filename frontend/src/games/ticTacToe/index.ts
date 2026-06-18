import { register } from "../registry";
import { TicTacToePvpWindow } from "./TicTacToePvpWindow";
import { TttBotWindow } from "./TttBotWindow";

// Real two-player PvP: matchmaking + relay co-sign + on-chain stakes.
register({
  id: "tic-tac-toe",
  name: "Tic Tac Toe PvP",
  icon: "⭕",
  Window: TicTacToePvpWindow,
});

// Bot-vs-bot self-play over a real tunnel; reports activity to the control-plane + live panels.
register({
  id: "tic-tac-toe-bots",
  name: "Tic Tac Toe Bots",
  icon: "🤖",
  Window: TttBotWindow,
});
