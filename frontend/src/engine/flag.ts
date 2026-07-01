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
