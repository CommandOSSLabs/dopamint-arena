import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "quantum-poker",
  name: "Quantum Poker",
  icon: "🎴",
  Window: makePlaceholder("Quantum Poker"),
});
