import { register } from "../registry";
import { PaymentsWindow } from "./PaymentsWindow";

register({
  id: "regular-payments",
  name: "Regular Payments",
  icon: "💸",
  Window: PaymentsWindow,
});
