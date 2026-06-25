import { register } from "../registry";
import { AgentMicropaymentsWindow } from "./AgentMicropaymentsWindow";

// Agent Micropayments — a tunnel-based bot-vs-bot self-play demo (M2M pay-per-request).
// A payment-workspace app; surfaced under the Add dialog's Payment group.
register({
  id: "agent-micropayments",
  name: "Agent Micropayments",
  description: "Watch a consumer agent stream pay-per-request to a provider.",
  catalog: false,
  workspace: "payment",
  icon: "🔁",
  image: "",
  Window: AgentMicropaymentsWindow,
});
