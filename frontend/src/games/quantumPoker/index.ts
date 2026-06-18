import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "quantum-poker",
  name: "Quantum Poker",
  icon: "🎴",
  image: "/games/poker.png",
  Window: makePlaceholder("Quantum Poker"),
});
