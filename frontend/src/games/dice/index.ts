import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "dice",
  name: "Dice",
  icon: "🎲",
  image: "/games/dice.png",
  Window: makePlaceholder("Dice"),
});
