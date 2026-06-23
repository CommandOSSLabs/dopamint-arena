import { register } from "../registry";
import { QuantumPokerModeWindow } from "./QuantumPokerModeWindow";

// Quantum Poker lanes (all local/relay — no game server):
// - Bot: human plays party A; a random-persona bot plays party B over a
//   wallet-funded self-play tunnel, settled gas-free via /settle.
// - PvP: two real wallets over DistributedTunnel + quickMatch (like Tic-Tac-Toe).
// - Auto: two persistent persona bots open/play/settle and loop real tunnels.
register({
  id: "quantum-poker",
  name: "Quantum Poker",
  description: "Heads-up poker, co-signed and settled on-chain.",
  icon: "🎴",
  image: "/games/poker.png",
  Window: QuantumPokerModeWindow,
});
