import { register } from "../registry";
import { BombItWindow } from "./BombItWindow";

register({
  id: "bomb-it",
  name: "Bomb It",
  icon: "💣",
  Window: BombItWindow,
});
