import { Bot, CheckCircle2, Loader2, Play, Server, Wallet } from "lucide-react";
import type { GameKit } from "@/agent/gameKit";
import { Button } from "@/components/ui/button";
import { MTPS_DECIMALS } from "@/onchain/mtps";
import { useTunnelSelfPlay, type SelfPlayStatus } from "./useTunnelSelfPlay";

const ONE_MTPS = 10n ** BigInt(MTPS_DECIMALS);

function fmtMtps(raw: bigint, dp = 3): string {
  const whole = raw / ONE_MTPS;
  const frac = (raw % ONE_MTPS)
    .toString()
    .padStart(MTPS_DECIMALS, "0")
    .slice(0, dp)
    .replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""}`;
}

const STATUS_LABEL: Record<SelfPlayStatus, string> = {
  idle: "Ready",
  opening: "Opening tunnel…",
  playing: "Streaming",
  settling: "Settling…",
  settled: "Settled",
  error: "Error",
};

const objUrl = (id: string) => `https://suiscan.xyz/testnet/object/${id}`;

/**
 * A real on-chain bot-vs-bot self-play view for a tunnel payment kit: one wallet
 * opens + funds both seats, the consumer bot pays the provider off-chain over the
 * tunnel, and it closes cooperatively through `/settle` — the same lifecycle as
 * every game. No simulation.
 */
export function PaymentSelfPlay<S, M>({
  windowId,
  createKit,
  stakePerSeat,
  countOf,
  consumer,
  provider,
  unit,
  blurb,
}: {
  windowId: string;
  /** Build the kit for a per-seat stake (price/cost scales to the stake). */
  createKit: (stakePerSeat: bigint) => GameKit<S, M>;
  stakePerSeat: bigint;
  countOf: (state: S) => bigint;
  consumer: string;
  provider: string;
  unit: string;
  blurb: string;
}) {
  const sp = useTunnelSelfPlay<S, M>(windowId, {
    createKit,
    stakePerSeat,
    countOf,
  });

  const busy =
    sp.status === "opening" ||
    sp.status === "playing" ||
    sp.status === "settling";
  const pct =
    sp.budget > 0n
      ? Math.min(100, Number((sp.providerEarned * 100n) / sp.budget))
      : 0;

  if (!sp.ready) {
    return (
      <div className="flex flex-col items-center gap-2 p-4 py-10 text-center">
        <Wallet className="size-7 text-arena-muted" />
        <p className="text-sm text-arena-muted">
          Sign in to run a real bot-vs-bot payment tunnel.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* consumer → provider */}
      <div className="flex items-center gap-2 text-sm">
        <span className="flex items-center gap-1.5 font-semibold text-arena-text">
          <Bot className="size-4 text-arena-accent" />
          {consumer}
        </span>
        <span className="text-arena-muted">→</span>
        <span className="flex items-center gap-1.5 text-arena-text">
          <Server className="size-4 text-arena-muted" />
          {provider}
        </span>
        <span className="ml-auto">
          <span
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              sp.status === "settled"
                ? "border-sky-400/40 text-sky-400"
                : sp.status === "error"
                  ? "border-rose-400/40 text-rose-400"
                  : busy
                    ? "border-emerald-400/40 text-emerald-400"
                    : "border-arena-edge text-arena-muted"
            }`}
          >
            {busy && <Loader2 className="size-3 animate-spin" />}
            {STATUS_LABEL[sp.status]}
          </span>
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-arena-muted">{blurb}</p>

      {/* meter */}
      <div className="rounded-lg border border-arena-edge bg-arena-bg/60 p-3">
        <div className="flex items-baseline justify-between text-[11px] text-arena-muted">
          <span className="uppercase tracking-wide">{provider} earned</span>
          <span className="font-mono text-arena-text">
            {fmtMtps(sp.providerEarned)} / {fmtMtps(sp.budget)} MTPS
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-arena-edge">
          <div
            className="h-full rounded-full bg-arena-accent transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[11px] text-arena-muted">
          <span>
            {consumer} left {fmtMtps(sp.consumerLeft)}
          </span>
          <span>
            {sp.count.toString()} {unit}
            {sp.count === 1n ? "" : "s"}
          </span>
        </div>
      </div>

      {/* live co-signed updates — every metered call is a REAL signed state update */}
      {sp.log.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-arena-muted">
            Co-signed updates
          </span>
          <ul className="flex flex-col gap-1">
            {sp.log.map((c) => (
              <li
                key={c.nonce}
                className="flex items-center gap-2 rounded border border-arena-edge bg-arena-bg/40 px-2 py-1 text-xs"
              >
                <span className="font-mono text-arena-muted">#{c.nonce}</span>
                <span className="text-arena-text">
                  +{fmtMtps(c.amount)} MTPS
                </span>
                <span className="ml-auto truncate font-mono text-[10px] text-arena-muted">
                  sig {c.sig} · {c.stateHash}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* run */}
      <Button onClick={sp.start} disabled={busy} className="gap-1.5">
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        {busy
          ? STATUS_LABEL[sp.status]
          : sp.status === "settled"
            ? "Run again"
            : "Run on testnet"}
      </Button>

      {sp.error && (
        <p className="rounded border border-rose-400/40 bg-rose-400/10 px-2 py-1.5 text-xs text-rose-300">
          {sp.error}
        </p>
      )}

      {sp.status === "settled" && (
        <div className="flex items-center gap-1.5 rounded border border-emerald-400/40 bg-emerald-400/10 px-2 py-1.5 text-xs text-emerald-300">
          <CheckCircle2 className="size-4 shrink-0" />
          Settled — {provider} earned {fmtMtps(sp.providerEarned)} MTPS over{" "}
          {sp.count.toString()} {unit}s.
        </div>
      )}

      {/* on-chain links */}
      {(sp.openDigest || sp.settleUrl) && (
        <div className="flex flex-col gap-1 text-[11px]">
          {sp.openDigest && (
            <a
              href={objUrl(sp.openDigest)}
              target="_blank"
              rel="noreferrer"
              className="text-arena-accent hover:underline"
            >
              Tunnel on explorer ↗
            </a>
          )}
          {sp.settleUrl && (
            <a
              href={sp.settleUrl}
              target="_blank"
              rel="noreferrer"
              className="text-arena-accent hover:underline"
            >
              Settle tx ↗{sp.proofUrl ? " · proof on Walrus ✓" : ""}
            </a>
          )}
        </div>
      )}

      <p className="text-[10px] leading-relaxed text-arena-muted">
        One wallet opens + funds both seats; the consumer streams pay-per-{unit}
        off-chain over the tunnel, closed cooperatively through /settle — the
        same lifecycle every game uses.
      </p>
    </div>
  );
}
