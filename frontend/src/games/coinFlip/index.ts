import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "coin-flip",
  name: "Coin Flip",
  icon: "🪙",
  Window: makePlaceholder("Coin Flip"),
});
