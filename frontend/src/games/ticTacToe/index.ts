import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "tic-tac-toe",
  name: "Tic Tac Toe",
  icon: "⭕",
  Window: makePlaceholder("Tic Tac Toe"),
});
