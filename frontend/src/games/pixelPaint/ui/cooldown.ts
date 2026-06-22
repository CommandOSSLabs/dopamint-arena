/** Pure cooldown math shared by the hook and the CooldownRing. */
export function cooldownState(now: number, endsAt: number, totalMs: number) {
  const remainingMs = Math.max(0, endsAt - now);
  const active = remainingMs > 0 && totalMs > 0;
  const fraction =
    totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 0;
  return { active, remainingMs, fraction };
}

export type Cooldown = ReturnType<typeof cooldownState>;
