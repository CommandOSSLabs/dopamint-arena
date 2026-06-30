import { register } from "../registry";
import { BombItWindow } from "./BombItWindow";
import { BOMB_IT_ARENA_GAME_ID } from "./usePvpBombIt";

register({
  id: "bomb-it",
  name: "Bomb It",
  description: "Flip tiles, dodge the bomb, bank your streak.",
  icon: "💣",
  image: "/games/bomb-it.png",
  Window: BombItWindow,
  // Wired into the co-located fleet (Rust↔TS parity verified: name, JSON moves, encode_state, seed).
  // The centralized batched entry deposits its seat A and the window auto-enters from the store.
  arenaGameId: BOMB_IT_ARENA_GAME_ID,
});
