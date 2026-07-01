import type { GameWindowProps } from "../types";
import { QuantumPokerPvpWindow } from "./QuantumPokerPvpWindow";

// Quantum Poker is PvP-only: two real wallets over DistributedTunnel + quickMatch
// (like Tic-Tac-Toe). Open straight into the live lane — its hook's resume() reattaches
// an in-flight match on reload. Back settles this hand and returns to the lobby; the
// window closes only via the title-bar ✕.
export function QuantumPokerModeWindow(props: GameWindowProps) {
  return <QuantumPokerPvpWindow {...props} />;
}
