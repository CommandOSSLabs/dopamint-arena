import { register } from "../registry";
import { BattleshipWindow } from "./BattleshipWindow";

// Battleship: hidden-fleet commit-reveal over a real tunnel (vs-bot in M1). See ADR 0003.
register({
  id: "battleship",
  name: "Battleship",
  description: "Hide your fleet, commit-reveal every shot.",
  icon: "🚢",
  image: "/games/battleship.png",
  Window: BattleshipWindow,
});
