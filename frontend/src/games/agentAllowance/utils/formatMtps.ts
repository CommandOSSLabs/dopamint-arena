import { MTPS_DECIMALS } from "@/onchain/mtps";

const ONE_MTPS = 10n ** BigInt(MTPS_DECIMALS);

/** Parse a decimal MTPS string ("0.5", "100") to raw base units. */
export function parseMtps(input: string): bigint {
  const [whole = "0", frac = ""] = input.trim().split(".");
  const fracPadded = (frac + "0".repeat(MTPS_DECIMALS)).slice(0, MTPS_DECIMALS);
  const w = BigInt(whole.replace(/[^0-9]/g, "") || "0");
  const f = BigInt(fracPadded.replace(/[^0-9]/g, "") || "0");
  return w * ONE_MTPS + f;
}

/** Format raw MTPS base units as a trimmed decimal string. */
export function formatMtps(raw: bigint, dp = 4): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const whole = v / ONE_MTPS;
  const frac = (v % ONE_MTPS)
    .toString()
    .padStart(MTPS_DECIMALS, "0")
    .slice(0, dp)
    .replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function timeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
