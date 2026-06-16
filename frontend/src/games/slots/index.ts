import { register } from "../registry";
import { makePlaceholder } from "../GamePlaceholder";

register({
  id: "slots",
  name: "Slots",
  icon: "🎰",
  Window: makePlaceholder("Slots"),
});
