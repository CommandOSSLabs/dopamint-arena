import { register } from "../registry";
import { RegularPaymentsWindow } from "./components/RegularPaymentsWindow";
import {
  REGULAR_PAYMENTS_ARENA_GAME_ID,
  REGULAR_PAYMENTS_GAME_ID,
} from "./utils/constants";

register({
  id: REGULAR_PAYMENTS_GAME_ID,
  name: "Regular Payments",
  catalog: true,
  workspace: "payment",
  icon: "🛒",
  image: "/games/payment.png",
  Window: RegularPaymentsWindow,
  arenaGameId: REGULAR_PAYMENTS_ARENA_GAME_ID,
});
