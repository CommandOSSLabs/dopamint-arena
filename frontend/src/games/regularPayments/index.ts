import { register } from "../registry";
import { PaymentsWindow } from "./PaymentsWindow";

register({
  id: "regular-payments",
  name: "Regular Payments",
  icon: "💸",
  image: "/games/payment.png",
  Window: PaymentsWindow,
});
