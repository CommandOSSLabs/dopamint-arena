import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

// A default floating widget, not a catalog game (catalog: false).
register({
  id: "chat",
  name: "Chat",
  catalog: false,
  icon: "💬",
  image: "/games/chat-app.png",
  Window: makePlaceholder("Chat"),
});
