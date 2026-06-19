import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "coin-flip",
  name: "Coin Flip",
  icon: "🪙",
  image: "/games/coin-flip.png",
  Window: makePlaceholder("Coin Flip"),
});
