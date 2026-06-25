import type { GameWindowProps } from "../types";
import { ChatPanel } from "../../panels/ChatPanel";

/** The chat workspace's window: the community chat panel filling the window chrome.
 *  Multiple can open at once (future: separate rooms/channels per instance). */
export function ChatWindow(_props: GameWindowProps) {
  return <ChatPanel className="h-full" />;
}
