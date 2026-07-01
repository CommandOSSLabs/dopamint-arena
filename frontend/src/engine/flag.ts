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

/** Opt-in (`?enginepool=1`): per-window game worker + one shared SOCKET worker (ADR-0029 Phase 2),
 *  instead of the single shared hub worker. Spreads co-sign across cores + isolates a game's fault to
 *  its worker while keeping the one-relay-socket invariant. Off by default during rollout; only takes
 *  effect when the worker engine is on ({@link engineEnabled}). */
export function enginePoolEnabled(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).get("enginepool") === "1";
}
