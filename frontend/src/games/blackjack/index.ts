import { register } from "../registry";
import { BlackjackWindow } from "./BlackjackWindow";
import { BLACKJACK_ARENA_GAME_ID } from "./app/hooks/usePvpBlackjack";

register({
  id: "blackjack",
  name: "Blackjack",
  description: "Beat the dealer to 21 — every hand co-signed on a real tunnel.",
  icon: "🃏",
  image: "/games/blackjack.png",
  Window: BlackjackWindow,
  // Wired into the co-located fleet: Rust `blackjack.v2` (variable-bet commit-reveal) byte-matches the
  // FE `BlackjackProtocol`, gated by TS-sourced goldens. The batched entry deposits seat A and the
  // window auto-enters from the store (user = A/player, fleet bot = B/dealer).
  arenaGameId: BLACKJACK_ARENA_GAME_ID,
});
