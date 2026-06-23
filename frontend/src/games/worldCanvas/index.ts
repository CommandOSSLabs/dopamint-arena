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
  // A wide wall wants room to pan/zoom; floor still shows the canvas + HUD.
  defaultSize: { w: 7, h: 8 },
  minSize: { w: 5, h: 6 },
});
