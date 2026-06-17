import { register } from "../registry";
import { QuantumPokerWindow } from "./QuantumPokerWindow";

register({
  id: "quantum-poker",
  name: "Quantum Poker",
  icon: "🎴",
  image: "/games/poker.png",
  Window: QuantumPokerWindow,
});
