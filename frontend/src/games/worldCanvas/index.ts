import { register } from "../registry";
import { WorldCanvasWindow } from "./WorldCanvasWindow";

// The World is Your Canvas: an infinite, collaborative pixel wall where each
// painted cell is one co-signed off-chain tunnel move and "Agent AI" spawns bots
// that co-paint forever. Phase 0 — canvas-only, self-play, sponsored gas.
register({
  id: "world-canvas",
  name: "The World is Your Canvas",
  icon: "🌍",
  image: "/games/world-canvas.png",
  Window: WorldCanvasWindow,
  // Opens compact like the other arena games (tic-tac-toe / chicken-cross resolve to
  // the 4×4 default); the canvas pans/zooms and the window resizes for a bigger wall.
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 3 },
});
