import { cn } from "@/lib/utils";

const RADIUS = 26;
const CIRC = 2 * Math.PI * RADIUS;

/**
 * Circular progress gauge with a value in the centre. Adapted from nullframe's
 * RenderCard FPS ring; colours come from design-system tokens and the arc eases
 * to new values so it animates as the metric drifts.
 */
export function RadialGauge({
  value,
  display,
  tone = "success",
  className,
}: {
  /** Fraction 0..1 the arc fills. */
  value: number;
  /** Pre-formatted text shown in the centre. */
  display: string;
  tone?: "primary" | "success";
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div
      className={cn(
        "relative grid size-16 shrink-0 place-items-center",
        className,
      )}
    >
      <svg viewBox="0 0 64 64" className="size-full -rotate-90">
        <circle
          cx="32"
          cy="32"
          r={RADIUS}
          fill="none"
          strokeWidth="6"
          className="stroke-border"
        />
        <circle
          cx="32"
          cy="32"
          r={RADIUS}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - pct)}
          className={cn(
            "transition-[stroke-dashoffset] duration-500",
            tone === "success" ? "stroke-success" : "stroke-primary",
          )}
        />
      </svg>
      <span className="absolute wal-mono text-xs font-semibold tabular-nums text-foreground">
        {display}
      </span>
    </div>
  );
}
