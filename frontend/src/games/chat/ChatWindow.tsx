import type { GameWindowProps } from "../types";
import ChatGameWindow from "./ChatGameWindow";

/** The chat workspace's window: the playable chat game fills the window chrome. */
export function ChatWindow(props: GameWindowProps) {
  return <ChatGameWindow {...props} />;
}
