import { register } from "../registry";
import { BlackjackWindow } from "./BlackjackWindow";

register({
  id: "blackjack",
  name: "Blackjack",
  icon: "🃏",
  image: "/games/blackjack.png",
  Window: BlackjackWindow,
  defaultSize: { w: 5, h: 7 },
  minSize: { w: 4, h: 5 },
});
