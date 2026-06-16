import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "blackjack",
  name: "Blackjack",
  icon: "🃏",
  Window: makePlaceholder("Blackjack"),
});
