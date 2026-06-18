import { register } from "../registry";
import { BlackjackWindow } from "./BlackjackWindow";

register({
  id: "blackjack",
  name: "Blackjack",
  icon: "🃏",
  Window: BlackjackWindow,
});
