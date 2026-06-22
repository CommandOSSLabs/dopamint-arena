import { register } from "../registry";
import { PaintWindow } from "./PaintWindow";

register({
  id: "pixel-paint",
  name: "Pixel Wall",
  icon: "🎨",
  image: "/games/pixel-paint.png",
  Window: PaintWindow,
  defaultSize: { w: 7, h: 8 },
  minSize: { w: 5, h: 6 },
});
