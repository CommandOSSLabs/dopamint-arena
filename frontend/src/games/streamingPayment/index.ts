import { register } from "../registry";
import { StreamingPaymentWindow } from "./components/StreamingPaymentWindow";

register({
  id: "streaming-payment",
  name: "Streaming Payment",
  description: `Pay someone over time — verified stream ticks + on-chain escrow.`,
  catalog: true,
  workspace: "payment",
  icon: "💧",
  image: "/games/payment.png",
  Window: StreamingPaymentWindow,
});
