import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "chat",
  name: "Chat",
  icon: "💬",
  image: "/games/chat-app.png",
  Window: makePlaceholder("Chat"),
});
