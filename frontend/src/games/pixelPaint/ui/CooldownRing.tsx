import { DUEL, FONT_MONO } from "./tokens";
import type { Cooldown } from "./cooldown";

/**
 * Conic cooldown ring that drains as the place-cooldown counts down (NIANEZ
 * style). A `conic-gradient` arc over a frosted inner disc shows the remaining
 * fraction; the center reads the seconds left, or ✓ when ready.
 */
export function CooldownRing({ cooldown }: { cooldown: Cooldown }) {
  const deg = cooldown.active ? Math.min(360, cooldown.fraction * 360) : 0;
  const color = cooldown.active ? DUEL.cyan : DUEL.muted;
  const label = cooldown.active
    ? `${Math.ceil(cooldown.remainingMs / 1000)}s`
    : "✓";
  return (
    <div
      className="relative h-[46px] w-[46px] rounded-full"
      style={{
        background: `conic-gradient(${DUEL.cyan} ${deg}deg, rgba(255,255,255,0.1) 0deg)`,
      }}
    >
      <div
        className="absolute inset-1 flex items-center justify-center rounded-full text-[11px] font-bold"
        style={{
          background: "rgba(20,24,48,0.72)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          fontFamily: FONT_MONO,
          color,
        }}
      >
        {label}
      </div>
    </div>
  );
}
