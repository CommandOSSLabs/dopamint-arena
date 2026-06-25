import { MINT_DURATION_MS } from "../constants";
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
  { fill: string; stroke: string; text: string; led: string; pulse?: boolean }
> = {
  spawning: {
    fill: "#ffe9bd",
    stroke: "#e8920c",
    text: "text-[#e8920c]",
    led: "bg-[#e8920c]",
    pulse: true,
  },
  running: {
    fill: "#e7f1fb",
    stroke: "#1971c2",
    text: "text-[#1971c2]",
    led: "bg-[#1971c2]",
    pulse: true,
  },
  settling: {
    fill: "#ffe9bd",
    stroke: "#e8920c",
    text: "text-[#e8920c]",
    led: "bg-[#e8920c]",
    pulse: true,
  },
  closed: {
    fill: "#eaf8ee",
    stroke: "#2f9e44",
    text: "text-[#2f9e44]",
    led: "bg-[#2f9e44]",
  },
  error: {
    fill: "#ffe9e9",
    stroke: "#e03131",
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
      return "Posting settle to backend…";
    case "spawning":
      return "Opening tunnel on-chain…";
    case "closed":
      return "Tunnel settled on-chain";
    case "error":
      return error ?? "Something went wrong";
    default:
      return "Starting stream…";
  }
}

export type MachineCardProps = {
  session: MachineSessionView;
};

export function MachineCard({ session }: MachineCardProps) {
  const { phase, error, tickCount, tickMax, tps, tier } = session;

  const pct = tickMax > 0 ? Math.min(100, (tickCount / tickMax) * 100) : 0;
  const showTier = phase === "settling" || phase === "closed";
  const displayTier = showTier ? tier : "unknown";
  const isStreaming = phase === "running";
  const status = STATUS_STYLE[phase];

  const prizeFill = isStreaming ? "#eef4fb" : "#eaf8ee";
  const prizeStroke = isStreaming ? "#1971c2" : "#2f9e44";
  const prizeBorder = isStreaming ? 3 : 3;

  return (
    <article className="relative isolate min-w-0 rounded-[11px] p-[clamp(6px,2cqmin,12px)]">
      <span
        className={`${SKETCH_INK} -z-10 rounded-[11px]`}
        style={{
          backgroundColor: "#fffefb",
          borderColor: "#23221f",
          borderWidth: 2.5,
        }}
      />

      <header className="mb-1.5 flex items-center justify-end">
        <span
          className={`relative isolate inline-flex items-center gap-[0.35em] px-[clamp(6px,1.8cqmin,12px)] py-[clamp(1px,0.6cqmin,4px)] text-[clamp(9px,2.4cqmin,13px)] leading-none tracking-wide uppercase ${status.text}`}
        >
          <span
            className={`${SKETCH_INK} -z-10 rounded-full`}
            style={{
              backgroundColor: status.fill,
              borderColor: status.stroke,
              borderWidth: 2,
            }}
          />
          <span
            className={`size-[0.45em] rounded-full ${status.led} ${status.pulse ? "animate-pulse" : ""}`}
          />
          {STATUS_LABEL[phase]}
        </span>
      </header>

      <div className="relative isolate mb-2 rounded-[10px] px-[clamp(8px,2.4cqmin,16px)] py-[clamp(6px,2cqmin,14px)] text-center">
        <span
          className={`${SKETCH_INK} -z-10 rounded-[10px]`}
          style={{
            backgroundColor: prizeFill,
            borderColor: prizeStroke,
            borderWidth: prizeBorder,
          }}
        />
        <div className="text-[clamp(1.1rem,5cqmin,1.75rem)] leading-none">
          {TIER_ICON[displayTier]}
        </div>
        <div
          className={`text-[clamp(10px,2.8cqmin,15px)] leading-tight font-bold tracking-wide uppercase ${TIER_TEXT[displayTier]}`}
        >
          {showTier ? TIER_LABEL[displayTier] : "Mystery"}
        </div>
        <p className="mt-0.5 truncate text-[clamp(9px,2.4cqmin,13px)] text-[rgba(35,34,31,0.6)]">
          {prizeHint(phase, error)}
        </p>
      </div>

      <div className="mb-2">
        <div className="mb-1 flex items-baseline justify-between gap-1">
          <span className="text-[clamp(9px,2.4cqmin,13px)] font-bold tracking-wide text-[rgba(35,34,31,0.6)] uppercase">
            Progress
          </span>
          <span className="font-['Space_Mono',_ui-monospace,_monospace] text-[clamp(9px,2.5cqmin,14px)] font-bold">
            {tickCount}/{tickMax}
          </span>
        </div>

        <div className="relative isolate h-[clamp(8px,2.4cqmin,14px)] overflow-hidden rounded-full bg-[rgba(35,34,31,0.06)]">
          <span
            className={`${SKETCH_INK} z-10 rounded-full`}
            style={{
              backgroundColor: "transparent",
              borderColor: "#e8920c",
              borderWidth: 2,
            }}
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
            ["Mint", `${MINT_DURATION_MS / 1000}s`],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            className="relative isolate rounded-lg px-[clamp(4px,1.4cqmin,10px)] py-[clamp(3px,1.2cqmin,8px)] text-center"
          >
            <span
              className={`${SKETCH_INK} -z-10 rounded-lg`}
              style={{
                backgroundColor: "#fffefb",
                borderColor: "#23221f",
                borderWidth: 2.5,
              }}
            />
            <span className="block text-[clamp(8px,2.2cqmin,12px)] tracking-wide text-[rgba(35,34,31,0.6)] uppercase">
              {label}
            </span>
            <span className="block font-['Space_Mono',_ui-monospace,_monospace] text-[clamp(11px,3cqmin,17px)] leading-tight">
              {value}
            </span>
          </div>
        ))}
      </div>
    </article>
  );
}
