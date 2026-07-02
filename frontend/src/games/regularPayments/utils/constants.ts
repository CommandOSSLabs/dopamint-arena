import { mtps } from "@/onchain/mtps";

/** Shopper (party A) budget locked at Go shop. */
export const DEPOSIT_BUDGET = mtps(500n);

/** Store POS (party B) activation dust — same wallet funds both seats at open. */
export const DEPOSIT_B_DUST = 1n;

/** Full-budget stream tick count (design target ~100 TPS over ~5 s). */
export const TICK_COUNT = 500;

export const MICRO_UNIT = DEPOSIT_BUDGET / BigInt(TICK_COUNT);

/** Target wall-clock duration for a full-budget pay stream (ms). */
export const STREAM_DURATION_MS = 5_000;

/** Manual pick pacing so fly-to-cart animation stays visible (auto burst skips this). */
export const AUTO_ADD_INTERVAL_MS = 5;

/** Auto burst wall-clock budget per shopping trip (design §6.4 time-budget loop). */
export const AUTO_BURST_BUDGET_MS = 5_000;

/** Flush cart/balance UI every N confirmed picks during auto burst (design §6.5). */
export const AUTO_UI_BATCH_STEPS = 8;

/** Auto-trip cart targets (random pick per round). */
export const AUTO_TARGET_CHOICES = [
  mtps(300n),
  mtps(350n),
  mtps(400n),
  mtps(450n),
] as const;

/** UI registry id (hyphen) — agent kit, settle label, telemetry feed tabs. */
export const REGULAR_PAYMENTS_GAME_ID = "regular-payments" as const;

/** Backend arena / `profile_for` id (underscore) — allocate, registerSession, fleet env. */
export const REGULAR_PAYMENTS_ARENA_GAME_ID = "regular_payments" as const;
