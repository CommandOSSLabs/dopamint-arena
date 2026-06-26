import { register } from "../registry";
import { StreamingPaymentWindow } from "./StreamingPaymentWindow";

// Streaming Payment — a salary/subscription/vesting money stream. A payment-workspace app,
// kept out of the games catalog (catalog: false); surfaced under the Add dialog's Payment group.
register({
  id: "streaming-payment",
  name: "Streaming Payment",
  description: "Pay someone over time — unlocks every second, cancel anytime.",
  catalog: false,
  workspace: "payment",
  icon: "💧",
  image: "",
  Window: StreamingPaymentWindow,
});
