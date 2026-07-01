import { register } from "../registry";
import { RegularPaymentsWindow } from "./components/RegularPaymentsWindow";

register({
  id: "regular-payments",
  name: "Regular Payments",
  catalog: true,
  workspace: "payment",
  icon: "🛒",
  image: "/games/payment.png",
  Window: RegularPaymentsWindow,
});
