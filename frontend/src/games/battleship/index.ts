import { register } from "../registry";
import { BattleshipWindow } from "./BattleshipWindow";
import { BATTLESHIP_ARENA_GAME_ID } from "./useBattleshipPvp";

// Battleship: hidden-fleet commit-reveal over a real tunnel (vs-bot in M1). See ADR 0003.
register({
  id: "battleship",
  name: "Battleship",
  description: "Hide your fleet, commit-reveal every shot.",
  icon: "🚢",
  image: "/games/battleship.png",
  Window: BattleshipWindow,
  // Wired into the co-located fleet (Rust `battleship.v1` ↔ FE; move-wire fixed: bare-hex root/salt/
  // proof, `isShip`; verified golden). The batched entry deposits seat A; the window auto-enters from
  // the store on autopilot vs the fleet bot (random fleet generated for the user's seat).
  arenaGameId: BATTLESHIP_ARENA_GAME_ID,
});
