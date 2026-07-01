export const DURATIONS = [
  { label: "1 minute", ms: 60_000n }, // 1 * 60 * 1000
  { label: "3 minutes", ms: 180_000n }, // 3 * 60 * 1000
  { label: "5 minutes", ms: 300_000n }, // 5 * 60 * 1000
] as const;

/**
 * Auto mode burst interval — matches Regular Payments `AUTO_ADD_INTERVAL_MS`.
 * ~200 verified co-signs/s per stream (off-chain; not on-chain txs).
 */
export const AUTO_TICK_INTERVAL_MS = 5;

/** Dashboard inline completion banner — auto-return to lobby (matches Regular Payments). */
export const AUTO_RETURN_SEC = 3;

export const MINIMUM_AMOUNT = "100";

/**
 * Clock meter refresh — setInterval, not RAF, so progress still advances when the
 * tab is backgrounded (RAF pauses; intervals are only throttled, not frozen).
 */
export const CLOCK_METER_INTERVAL_MS = 100;

export const GAME_ID = "streaming-payment";

export const TX_EXPLORER_URL = (digest: string) =>
  `https://suiscan.xyz/testnet/tx/${digest}`;

export const OBJ_EXPLORER_URL = (id: string) =>
  `https://suiscan.xyz/testnet/object/${id}`;

/**
 * Fixed recipient for this phase (sender dashboard).
 * Receiver is hardcoded — no recipient selection in lobby.
 */
export const FIXED_RECIPIENT =
  "0x2b94292a16c3da16db6b9453d3327c8d60ae2c22111b0b854c1bd094a1080643";
export const FIXED_RECIPIENT_NAME = "Contractor";
