import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "chat",
  name: "Chat",
  icon: "💬",
  Window: makePlaceholder("Chat"),
});
