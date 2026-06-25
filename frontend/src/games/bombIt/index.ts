import { register } from "../registry";
import { BombItWindow } from "./BombItWindow";

register({
  id: "bomb-it",
  name: "Bomb It",
  description: "Flip tiles, dodge the bomb, bank your streak.",
  icon: "💣",
  image: "/games/bomb-it.png",
  Window: BombItWindow,
});
