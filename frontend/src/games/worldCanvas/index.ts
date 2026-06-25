import { register } from "../registry";
import { WorldCanvasWindow } from "./WorldCanvasWindow";

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
});
