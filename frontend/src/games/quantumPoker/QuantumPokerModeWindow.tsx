import type { GameWindowProps } from "../types";
import { QuantumPokerPvpWindow } from "./QuantumPokerPvpWindow";

// Quantum Poker is PvP-only: two real wallets over DistributedTunnel + quickMatch
// (like Tic-Tac-Toe). Open straight into the live lane — its hook's resume() reattaches
// an in-flight match on reload. Back settles this hand and closes the window.
export function QuantumPokerModeWindow(props: GameWindowProps) {
  return <QuantumPokerPvpWindow {...props} onExit={props.onClose} />;
}
