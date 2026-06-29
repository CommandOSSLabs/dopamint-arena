import type { GameWindowProps } from "../types";
import App from "./app/App";

/** The integrated Tic-Tac-Toe & Caro game running as a Native Component window. */
export function TicTacToeWindow({ windowId }: GameWindowProps) {
  return <App windowId={windowId} />;
}
