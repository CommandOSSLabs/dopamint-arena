import { DUEL } from "./tokens";
import type { Cooldown } from "./cooldown";

/** SVG ring that drains as the place-cooldown counts down (NIANEZ style). */
export function CooldownRing({ cooldown }: { cooldown: Cooldown }) {
  const R = 19;
  const CIRC = 2 * Math.PI * R;
  const offset = CIRC * (1 - cooldown.fraction);
  return (
    <div className="relative h-[46px] w-[46px]">
      <svg
        width="46"
        height="46"
        viewBox="0 0 46 46"
        style={{ transform: "rotate(-90deg)" }}
      >
        <circle
          cx="23"
          cy="23"
          r={R}
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth="4"
        />
        {cooldown.active && (
          <circle
            cx="23"
            cy="23"
            r={R}
            fill="none"
            stroke={DUEL.cyan}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={offset}
            style={{
              filter: `drop-shadow(0 0 4px ${DUEL.cyan})`,
              transition: "stroke-dashoffset 0.2s linear",
            }}
          />
        )}
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-bold"
        style={{ color: cooldown.active ? DUEL.cyan : DUEL.muted }}
      >
        {cooldown.active ? `${Math.ceil(cooldown.remainingMs / 1000)}s` : "✓"}
      </span>
    </div>
  );
}
