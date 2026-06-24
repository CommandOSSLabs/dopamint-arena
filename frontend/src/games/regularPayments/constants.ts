/** 1 SUI = 1e9 MIST. */

/**
 * User (party A) — the full purchase budget (0.1 SUI). All micro-payments stream A → shop B.
 *
 * Party B does not bring its own wallet money. Move still requires `party_b_deposit > 0`
 * before a tunnel activates (`tunnel::maybe_activate`), so we fund B with the minimum
 * `MIN_DEPOSIT` (1 MIST) from the **same user wallet** at open — activation dust, not shop
 * capital.
 */
export const DEPOSIT_A_MIST = 100_000_000n;

/** Protocol activation dust for ephemeral shop B (from user wallet, not shop-funded). */
export const DEPOSIT_B_MIST = 1n;

/** Total the user wallet splits at open (A budget + B activation dust). */
export const OPEN_TOTAL_MIST = DEPOSIT_A_MIST + DEPOSIT_B_MIST;

/**
 * Co-signed payments per mint. More ticks at the same TPS lengthen the progress bar
 * without lowering the headline rate (500 @ 80 TPS ≈ 6.25 s).
 */
export const TICK_COUNT = 500;

/** Per tick — budget / tick count (0.1 SUI / 500 = 0.0002 SUI). */
export const MICRO_UNIT_MIST = DEPOSIT_A_MIST / BigInt(TICK_COUNT);

/**
 * Target co-signed payment rate per card (rolling 1s TPS readout caps near this).
 * Raise for faster mints; lower if the main thread struggles with many concurrent cards.
 * Practical smooth-UI ceiling in-browser is ~100–150 before progress feels jumpy.
 */
export const TARGET_STREAM_TPS = 80;

/** Wall-clock stream length: TICK_COUNT payments spread at TARGET_STREAM_TPS. */
export const STREAM_DURATION_MS = Math.ceil(
  (TICK_COUNT / TARGET_STREAM_TPS) * 1000,
);

/** Max machines in spawning / running / settling at once; settled slots free up for new mints. */
export const MAX_CONCURRENT_RUNNING = 20;

/** Target spacing between ticks when pacing the stream (informational). */
export const TICK_INTERVAL_MS = STREAM_DURATION_MS / TICK_COUNT;

/** Sample My Activity rows during stream (~20 rows per 500-tick mint at 80 TPS). */
export const LOCAL_TXN_SAMPLE_EVERY = 25;

/** Auto-mint interval — one spawn attempt per tick while auto mode is on. */
export const AUTO_MINT_INTERVAL_MS = 500;

/** Minimum gap between mint spawns — manual clicks, auto-interval, and bot-driven. */
export const MINT_COOLDOWN_MS = 200;

export const MIST_PER_SUI = 1_000_000_000n;

/**
 * Sender-pays `Tunnel<SUI>` when `VITE_MTPS_*` is unset. When MTPS is configured the open
 * path stakes MTPS via the gas sponsor instead; this flag only applies to the SUI fallback.
 */
export const PAYMENT_SHOP_STAKE_SUI = true;

export function mistToSui(mist: bigint): number {
  return Number(mist) / Number(MIST_PER_SUI);
}