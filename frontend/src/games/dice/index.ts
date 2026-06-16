import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "dice",
  name: "Dice",
  icon: "🎲",
  Window: makePlaceholder("Dice"),
});
