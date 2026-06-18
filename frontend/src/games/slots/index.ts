import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "slots",
  name: "Slots",
  icon: "🎰",
  image: "/games/slots.png",
  Window: makePlaceholder("Slots"),
});
