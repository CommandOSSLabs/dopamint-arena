import { register } from "../registry";
import { QuantumPokerPvpWindow } from "./QuantumPokerPvpWindow";

// PvP is the default (and only surfaced) lane: DistributedTunnel + quickMatch like Tic-Tac-Toe
// — two real wallets matchmake, each stakes, and the hand is co-signed over the relay.
register({
  id: "quantum-poker",
  name: "Quantum Poker",
  description: "Heads-up poker, co-signed and settled on-chain.",
  icon: "🎴",
  image: "/games/poker.png",
  Window: QuantumPokerPvpWindow,
});

// Backlog (kept in the tree, intentionally NOT registered → stays off the desktop): the
// user-vs-bot / solo lane — QuantumPokerWindow + runtime/serverRuntime/serverClient and
// packages/server. Re-register it here to bring the mode back.
