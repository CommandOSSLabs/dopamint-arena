import { register } from "../registry";
import { QuantumPokerPvpWindow } from "./QuantumPokerPvpWindow";
import { QuantumPokerWindow } from "./QuantumPokerWindow";

// PvP is the default lane (DistributedTunnel + quickMatch, like Tic-Tac-Toe): two real
// wallets matchmake, each stakes, and the hand is co-signed over the relay.
register({
  id: "quantum-poker",
  name: "Quantum Poker",
  icon: "🎴",
  image: "/games/poker.png",
  Window: QuantumPokerPvpWindow,
});

// Solo preview / server BUCK demo kept available alongside the PvP lane.
register({
  id: "quantum-poker-solo",
  name: "Quantum Poker (Solo)",
  icon: "🃏",
  image: "/games/poker.png",
  Window: QuantumPokerWindow,
});
