import { register } from "../registry";
import { ApiCreditsWindow } from "./ApiCreditsWindow";

// API Credits — a tunnel-based bot-vs-bot self-play demo (prepaid metered API calls).
// A payment-workspace app; surfaced under the Add dialog's Payment group.
register({
  id: "api-credits",
  name: "API Credits",
  description: "Watch a client spend prepaid credits per API call.",
  catalog: false,
  workspace: "payment",
  icon: "🔌",
  image: "",
  Window: ApiCreditsWindow,
});
