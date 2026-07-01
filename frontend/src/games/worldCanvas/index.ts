import { register } from "../registry";
import { WorldCanvasWindow } from "./WorldCanvasWindow";
import { WORLD_CANVAS_ARENA_GAME_ID } from "./usePvpWorldCanvas";

// The World is Your Canvas: an infinite, collaborative pixel wall where each
// painted cell is one co-signed off-chain move on ONE strictly-2-party tunnel —
// two funded bots co-paint it, and an Auto toggle lets you take seat A. Self-play,
// sponsored gas (the arena's standard solo on-ramp).
register({
  id: "world-canvas",
  name: "The World is Your Canvas",
  icon: "🌍",
  image: "/games/world-canvas.png",
  Window: WorldCanvasWindow,
  // Wired into the co-located fleet (Rust↔TS parity verified: name/domain, JSON moves, rolling-digest
  // encode_state). The centralized batched entry deposits its seat A; the window auto-enters from the
  // store. Endless co-draw (never terminal): the match plays vs the bot until the window closes.
  arenaGameId: WORLD_CANVAS_ARENA_GAME_ID,
});
