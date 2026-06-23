import { register } from "../registry";
import { ChickenCrossWindow } from "./ChickenCrossWindow";

register({
  id: "chicken-cross",
  name: "Chicken Cross",
  description: "Cross the road and cash out before you splat.",
  icon: "🐔",
  image: "/games/chicken-cross.png",
  Window: ChickenCrossWindow,
});
