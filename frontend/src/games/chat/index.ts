import { register } from "../registry";
import { ChatWindow } from "./ChatWindow";

register({
  id: "chat",
  name: "AI Chat",
  icon: "🤖",
  image: "/games/chat-app.png",
  Window: ChatWindow,
  defaultSize: { w: 4, h: 5 },
  minSize: { w: 3, h: 3 },
});
