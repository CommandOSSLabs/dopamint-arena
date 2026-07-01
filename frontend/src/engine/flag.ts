import { deviceTierInfo } from "./deviceTier";

/** Selects the worker-hosted tunnel client over the legacy main-thread path. DEFAULT-ON everywhere
 *  (dev and production): every game window drives its match through the worker engine unless an
 *  explicit `?engine=legacy` override forces the main-thread path. `?engine=worker` is kept as an
 *  explicit opt-in (e.g. to override a future kill-switch). All 8 games (PvP + solo) now have
 *  worker specs; legacy hooks remain for fallback only. Read once at module load (stable for the
 *  session). */
export function engineEnabled(): boolean {
  if (typeof location !== "undefined") {
    const v = new URLSearchParams(location.search).get("engine");
    if (v === "worker") return true;
    if (v === "legacy") return false;
  }
  return true;
}

/** Per-window game worker + one shared SOCKET worker (ADR-0029 Phase 2) instead of the single shared
 *  hub: spreads co-sign across cores + isolates a game's fault to its worker, keeping the one-relay-
 *  socket invariant. AUTO-ON for High/Max device tiers — there the `deviceTier` window cap is a memory
 *  budget that already assumes per-window isolates, and enough cores exist to actually parallelize, so
 *  the pool makes that advertised cap real; Low/Mid stay on the lighter one-worker hub. `?enginepool=1`
 *  forces on, `?enginepool=0` forces off (fallback). Only meaningful when the worker engine is on
 *  ({@link engineEnabled}); a stable per-session value (URL + device tier don't change mid-session). */
export function enginePoolEnabled(): boolean {
  if (typeof location !== "undefined") {
    const v = new URLSearchParams(location.search).get("enginepool");
    if (v === "1") return true;
    if (v === "0") return false;
  }
  const tier = deviceTierInfo().tier;
  return tier === "high" || tier === "max";
}
