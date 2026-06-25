import { useState } from "react";
import { useSuiClientContext } from "@mysten/dapp-kit";
import { ExternalLink } from "lucide-react";
import { suivisionTxUrl } from "@/lib/suivision";
import { formatMicroUnit } from "../constants";
import { SKETCH_INK } from "../sketchInk";
import type { MachinePhase, MachineSessionView, NftTier } from "../types";

const STATUS_LABEL: Record<MachinePhase, string> = {
  spawning: "Opening",
  running: "Running",
  settling: "Settling",
  closed: "Settled",
  error: "Error",
};

const TIER_LABEL: Record<NftTier, string> = {
  unknown: "???",
  common: "Common",
  rare: "Rare",
  epic: "Epic",
};

const TIER_ICON: Record<NftTier, string> = {
  unknown: "◆",
  common: "🃏",
  rare: "💎",
  epic: "✨",
};

const STATUS_STYLE: Record<
  MachinePhase,
  { paper: string; text: string; led: string; pulse?: boolean }
> = {
  spawning: {
    paper: "bg-[#ffe9bd] border-[#e8920c]",
    text: "text-[#e8920c]",
    led: "bg-[#e8920c]",
    pulse: true,
  },
  running: {
    paper: "bg-[#e7f1fb] border-[#1971c2]",
    text: "text-[#1971c2]",
    led: "bg-[#1971c2]",
    pulse: true,
  },
  settling: {
    paper: "bg-[#ffe9bd] border-[#e8920c]",
    text: "text-[#e8920c]",
    led: "bg-[#e8920c]",
    pulse: true,
  },
  closed: {
    paper: "bg-[#eaf8ee] border-[#2f9e44]",
    text: "text-[#2f9e44]",
    led: "bg-[#2f9e44]",
  },
  error: {
    paper: "bg-[#ffe9e9] border-[#e03131]",
    text: "text-[#e03131]",
    led: "bg-[#e03131]",
  },
};

const TIER_TEXT: Record<NftTier, string> = {
  unknown: "",
  common: "",
  rare: "text-[#1971c2]",
  epic: "text-[#e8920c]",
};

function formatTps(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function prizeHint(phase: MachinePhase, error?: string | null): string {
  switch (phase) {
    case "running":
      return "Streaming micro-payments…";
    case "settling":
      return "Settling tunnel & minting reward…";
    case "spawning":
      return "Opening tunnel on-chain…";
    case "closed":
      return "Reward delivered to your wallet";
    case "error":
      return error ?? "Something went wrong";
    default:
      return "Starting stream…";
  }
}

export type MachineCardProps = {
  session: MachineSessionView;
};

function TxLink({
  digest,
  label,
  network,
}: {
  digest: string;
  label: string;
  network: string;
}) {
  return (
    <a
      href={suivisionTxUrl(digest, network)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex w-full items-center justify-center gap-1 hover:opacity-70 text-sm text-blue-500"
    >
      {label}
      <ExternalLink className="size-[0.9em] shrink-0" strokeWidth={2.5} />
    </a>
  );
}

export function MachineCard({ session }: MachineCardProps) {
  const { phase, error, tickCount, tickMax, tps, tier, reward, digest } =
    session;
  const { network } = useSuiClientContext();
  const [imageFailed, setImageFailed] = useState(false);

  const pct = tickMax > 0 ? Math.min(100, (tickCount / tickMax) * 100) : 0;
  const revealed = phase === "closed";
  const showRewardImage = revealed && !!reward?.imageUrl && !imageFailed;
  const isStreaming = phase === "running";
  const isSettling = phase === "settling";
  const isNearComplete = (phase === "running" && pct >= 90) || isSettling;
  const status = STATUS_STYLE[phase];

  const prizePaper = isStreaming
    ? "bg-[#eef4fb] border-[#1971c2]"
    : isSettling
      ? "bg-[#ffe9bd] border-[#e8920c]"
      : "bg-[#eaf8ee] border-[#2f9e44]";
  const prizeBorderClass = "border-[3px]";

  return (
    <article className="relative isolate min-w-0 rounded-[11px] p-[clamp(6px,2cqmin,12px)] flex flex-col">
      <span
        className={`${SKETCH_INK} -z-10 rounded-[11px] bg-[#fffefb] border-[#23221f] border-[2.5px]`}
      />

      <header className="mb-1.5 flex items-center justify-end">
        <span
          className={`relative isolate inline-flex items-center gap-[0.35em] px-[clamp(6px,1.8cqmin,12px)] py-[clamp(1px,0.6cqmin,4px)] text-[clamp(9px,2.4cqmin,13px)] leading-none tracking-wide uppercase ${status.text}`}
        >
          <span
            className={`${SKETCH_INK} -z-10 rounded-full border-2 ${status.paper}`}
          />
          <span
            className={`size-[0.45em] rounded-full ${status.led} ${status.pulse ? "animate-pulse" : ""}`}
          />
          {STATUS_LABEL[phase]}
        </span>
      </header>

      <div
        className={`relative isolate mb-1 rounded-[10px] px-[clamp(8px,2.4cqmin,16px)] py-[clamp(6px,2cqmin,14px)] text-center ${
          isNearComplete ? "pshop-complete-blink" : ""
        }

        flex flex-col flex-1 justify-center
      `}
      >
        <span
          className={`${SKETCH_INK} -z-10 rounded-[10px] ${prizePaper} ${isNearComplete ? "border-[#2f9e44]" : ""} ${prizeBorderClass}`}
        />

        {showRewardImage ? (
          <img
            src={reward.imageUrl}
            alt={reward.title}
            className="mx-auto h-[clamp(4.5rem,20cqmin,7.5rem)] w-[clamp(4.5rem,20cqmin,7.5rem)] rounded-lg object-cover"
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="text-[clamp(1.1rem,5cqmin,1.75rem)] leading-none">
            {TIER_ICON[revealed ? tier : "unknown"]}
          </div>
        )}

        <div
          className={`mt-1 text-[clamp(10px,2.8cqmin,15px)] leading-tight font-bold tracking-wide uppercase ${TIER_TEXT[revealed ? tier : "unknown"]}`}
        >
          {revealed && reward
            ? reward.title
            : revealed
              ? TIER_LABEL[tier]
              : "Mystery"}
        </div>

        <p className="truncate leading-none text-[clamp(9px,2.4cqmin,13px)] text-[rgba(35,34,31,0.6)]">
          {revealed && reward ? reward.description : prizeHint(phase, error)}
        </p>

        {phase === "closed" && digest?.length ? (
          <TxLink digest={digest} label="View Detail" network={network} />
        ) : null}
      </div>

      <div>
        <div className="mb-2">
          <div className="mb-1 flex items-baseline justify-between gap-1">
            <span className="text-[clamp(9px,2.4cqmin,13px)] font-bold tracking-wide text-[rgba(35,34,31,0.6)] uppercase">
              Progress
            </span>
            <span className="font-Space-Mono text-[clamp(9px,2.5cqmin,14px)] font-bold">
              {tickCount}/{tickMax}
            </span>
          </div>

          <div className="relative isolate h-[clamp(8px,2.4cqmin,14px)] overflow-hidden rounded-full bg-[rgba(35,34,31,0.06)]">
            <span
              className={`${SKETCH_INK} z-10 rounded-full border-2 border-[#e8920c] bg-transparent`}
            />
            <div
              className={`h-full rounded-full bg-gradient-to-r from-[#d97706] via-[#e8920c] to-[#ffe9bd] transition-[width] duration-200 ease-out ${
                phase === "running" ? "animate-pulse" : ""
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <div className="mb-2 grid grid-cols-3 gap-1.5">
          {(
            [
              ["Ticks", String(tickCount)],
              ["TPS", phase === "running" ? formatTps(tps) : "—"],
              ["Unit", formatMicroUnit()],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="relative isolate rounded-lg px-[clamp(4px,1.4cqmin,10px)] py-[clamp(3px,1.2cqmin,8px)] text-center"
            >
              <span
                className={`${SKETCH_INK} -z-10 rounded-lg bg-[#fffefb] border-[#23221f] border-[2.5px]`}
              />
              <span className="block text-[clamp(8px,2.2cqmin,12px)] tracking-wide text-[rgba(35,34,31,0.6)] uppercase">
                {label}
              </span>
              <span className="block font-Space-Mono text-[clamp(11px,3cqmin,17px)] leading-tight">
                {value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
