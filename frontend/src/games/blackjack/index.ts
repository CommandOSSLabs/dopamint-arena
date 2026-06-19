import { register } from "../registry";
import { BlackjackWindow } from "./BlackjackWindow";

register({
  id: "blackjack",
  name: "Blackjack",
  icon: "🃏",
  image: "/games/blackjack.png",
  Window: BlackjackWindow,
});
