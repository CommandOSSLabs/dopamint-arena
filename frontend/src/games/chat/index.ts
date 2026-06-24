import { register } from "../registry";
import ChatIcon from "./ChatGameWindow";

register({
  id: "chat",
  name: "Chat",
  description: "Chat with a bot or watch bots chat",
  catalog: true,
  icon: "💬",
  image: "/games/chat-app.png",
  Window: ChatIcon,
});
