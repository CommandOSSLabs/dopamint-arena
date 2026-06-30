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
  // Wired into the co-located fleet (Rust↔TS parity verified, plays E2E). Underscore form = the
  // backend profile_for/FLEET_COLOCATED id; the centralized batched entry deposits its seat A.
  arenaGameId: "quantum_poker",
});
