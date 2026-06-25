import { register } from "../registry";
import { ChatWindow } from "./ChatWindow";

// A chat-workspace surface — kept out of the games catalog (catalog: false),
// surfaced instead under the Add dialog's Chat group. More chats can be added.
register({
  id: "chat",
  name: "Chat",
  catalog: false,
  workspace: "chat",
  icon: "💬",
  image: "/games/chat-app.png",
  Window: ChatWindow,
});
