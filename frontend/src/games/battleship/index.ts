import { register } from "../registry";
import { BattleshipWindow } from "./BattleshipWindow";

// Battleship: hidden-fleet commit-reveal over a real tunnel (vs-bot in M1). See ADR 0003.
register({
  id: "battleship",
  name: "Battleship",
  icon: "🚢",
  image: "/games/battleship.png",
  Window: BattleshipWindow,
  // Two 10×10 boards: open wide+tall enough to show them side-by-side, and keep a
  // floor that still fits one board stacked (BattleView reflows via container queries).
  defaultSize: { w: 6, h: 7 },
  minSize: { w: 4, h: 5 },
});
