import { register } from "../registry";
import { PaymentsWindow } from "./PaymentsWindow";

// A default floating widget, not a catalog game (catalog: false).
register({
  id: "regular-payments",
  name: "Regular Payments",
  catalog: false,
  icon: "💸",
  image: "/games/payment.png",
  Window: PaymentsWindow,
});
