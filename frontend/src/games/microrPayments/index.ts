import { register } from "../registry";
import { PaymentsWindow } from "./PaymentsWindow";

// The payment workspace's surface — kept out of the games catalog (catalog: false),
// surfaced instead under the Add dialog's Payment group.
register({
  id: "micro-payments",
  name: "Micro Payments",
  catalog: false,
  workspace: "payment",
  icon: "💸",
  image: "/games/payment.png",
  Window: PaymentsWindow,
});
