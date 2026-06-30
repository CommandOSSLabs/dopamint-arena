import { register } from "../registry";
import { ChickenCrossWindow } from "./ChickenCrossWindow";
import { CHICKEN_CROSS_ARENA_GAME_ID } from "./usePvpChickenCross";

register({
  id: "chicken-cross",
  name: "Chicken Cross",
  description: "Cross the road and cash out before you splat.",
  icon: "🐔",
  image: "/games/chicken-cross.png",
  Window: ChickenCrossWindow,
  // Wired into the co-located fleet (Rust↔TS parity verified: name, JSON moves, encode_state, seed).
  // The centralized batched entry deposits its seat A and the window auto-enters from the store.
  arenaGameId: CHICKEN_CROSS_ARENA_GAME_ID,
});
