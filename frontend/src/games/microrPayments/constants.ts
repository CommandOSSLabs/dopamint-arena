import { MTPS_DECIMALS, mtps } from "@/onchain/mtps";

/**
 * User (party A) — 10 MTPS purchase budget per mint. All micro-payments stream A → shop B.
 *
 * Party B does not bring its own wallet money. Move still requires `party_b_deposit > 0`
 * before a tunnel activates (`tunnel::maybe_activate`), so we fund B with the minimum
 * activation dust from the **same user wallet** at open — not shop capital.
 */
export const DEPOSIT_A = mtps(10n);

/** Protocol activation dust for ephemeral shop B (from user wallet, not shop-funded). */
export const DEPOSIT_B = 1n;

/** Total the user wallet funds at open (A budget + B activation dust). */
export const OPEN_TOTAL = DEPOSIT_A + DEPOSIT_B;

/**
 * Co-signed payments per mint. More ticks at the same TPS lengthen the progress bar
 * without lowering the headline rate (500 @ 100 TPS = 5 s).
 */
export const TICK_COUNT = 500;

/** Per tick — budget / tick count. */
export const MICRO_UNIT = DEPOSIT_A / BigInt(TICK_COUNT);

/** Human-readable MTPS amount for a raw micro-unit (shown on machine cards). */
export function formatMicroUnit(raw: bigint = MICRO_UNIT): string {
  const scale = 10n ** BigInt(MTPS_DECIMALS);
  const whole = raw / scale;
  const frac = raw % scale;
  if (frac === 0n) return whole.toString();
  const digits = frac
    .toString()
    .padStart(MTPS_DECIMALS, "0")
    .replace(/0+$/, "")
    .slice(0, 2)
    .replace(/0+$/, "");
  return digits ? `${whole}.${digits}` : whole.toString();
}

/** Wall-clock mint stream length. */
export const MINT_DURATION_MS = 5_000;

/**
 * Target co-signed payment rate per card (rolling 1s TPS readout caps near this).
 * Raise for faster mints; lower if the main thread struggles with many concurrent cards.
 */
export const TARGET_STREAM_TPS = Math.ceil(
  TICK_COUNT / (MINT_DURATION_MS / 1000),
);

export const STREAM_DURATION_MS = MINT_DURATION_MS;

/** Max machines in spawning / running / settling at once; settled slots free up for new mints. */
export const MAX_CONCURRENT_RUNNING = 20;

/** Target spacing between ticks when pacing the stream (informational). */
export const TICK_INTERVAL_MS = STREAM_DURATION_MS / TICK_COUNT;

/** Auto-mint interval — one spawn attempt per tick while auto mode is on. */
export const AUTO_MINT_INTERVAL_MS = 500;

/** Minimum gap between mint spawns — manual clicks, auto-interval, and bot-driven. */
export const MINT_COOLDOWN_MS = 200;

/**
 * Sender-pays `Tunnel<SUI>` when `VITE_MTPS_*` is unset. When MTPS is configured the open
 * path stakes MTPS via the gas sponsor instead; this flag only applies to the SUI fallback.
 */
export const PAYMENT_SHOP_STAKE_SUI = true;
