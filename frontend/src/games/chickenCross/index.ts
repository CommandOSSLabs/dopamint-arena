import { register } from "../registry";
import { ChickenCrossWindow } from "./ChickenCrossWindow";

register({
  id: "chicken-cross",
  name: "Chicken Cross",
  icon: "🐔",
  Window: ChickenCrossWindow,
});
