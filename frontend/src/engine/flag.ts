/** Selects the worker-hosted tunnel client over the legacy main-thread path. Explicit overrides:
 *  `?engine=worker` forces it ON, `?engine=legacy` forces it OFF. With no override it is the
 *  DEFAULT IN DEV (`import.meta.env.DEV`, for testing) and OPT-IN in production builds — until the
 *  perf gate + testnet verification land, prod stays legacy unless `?engine=worker`. Read once at
 *  module load (stable for the session). */
export function engineEnabled(): boolean {
  if (typeof location !== "undefined") {
    const v = new URLSearchParams(location.search).get("engine");
    if (v === "worker") return true;
    if (v === "legacy") return false;
  }
  return !!import.meta.env?.DEV;
}
