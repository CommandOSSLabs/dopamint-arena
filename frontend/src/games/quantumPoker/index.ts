import { register } from "../registry";
import { QuantumPokerModeWindow } from "./QuantumPokerModeWindow";

// Quantum Poker: heads-up PvP — two real wallets over DistributedTunnel +
// quickMatch (like Tic-Tac-Toe). Auto toggle (default off) lets a random-persona
// bot play your seat.
register({
  id: "quantum-poker",
  name: "Quantum Poker",
  description: "Heads-up poker, co-signed and settled on-chain.",
  icon: "🎴",
  image: "/games/poker.png",
  Window: QuantumPokerModeWindow,
});
