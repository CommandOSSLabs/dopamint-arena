import { register } from "../registry";
import { AgentAllowanceWindow } from "./components/AgentAllowanceWindow";

// Agent Allowance — a capped, rate-limited, revocable spending mandate for an
// autonomous agent ("OAuth for money" / x402-style). A payment-workspace app,
// kept out of the games catalog (catalog: false); surfaced under the Add
// dialog's Payment group. Empty image -> the 🤖 emoji renders as the icon.
register({
  id: "agent-allowance",
  name: "Agent Allowance",
  description: `Fund an AI agent to pay a metered API — capped, streamed, revocable.`,
  catalog: false,
  workspace: "payment",
  icon: "🤖",
  image: "",
  Window: AgentAllowanceWindow,
});
