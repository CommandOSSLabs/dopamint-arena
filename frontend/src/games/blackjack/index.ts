import { register } from "../registry";
import { BlackjackWindow } from "./BlackjackWindow";

register({
  id: "blackjack",
  name: "Blackjack",
  description: "Beat the dealer to 21 — every hand co-signed on a real tunnel.",
  icon: "🃏",
  image: "/games/blackjack.png",
  Window: BlackjackWindow,
});
