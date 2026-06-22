import { register } from "../registry";
import { BombItWindow } from "./BombItWindow";

register({
  id: "bomb-it",
  name: "Bomb It",
  icon: "💣",
  image: "/games/bomb-it.png",
  Window: BombItWindow,
});
