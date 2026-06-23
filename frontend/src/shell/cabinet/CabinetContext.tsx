import { createContext, useContext, useEffect } from "react";
import type { CabinetController } from "./CabinetController";

/** Internal seam: `GameCabinet` provides `register`; a game's App calls it. */
export interface CabinetRegistry {
  register(controller: CabinetController | null): void;
}

export const CabinetContext = createContext<CabinetRegistry | null>(null);

/**
 * Publish this game's `CabinetController` to the enclosing `<GameCabinet>`.
 * Re-registers whenever the controller identity changes and clears on unmount.
 * Pass a controller whose verbs are stable (useCallback) and rebuild it only
 * when `active` flips, so this doesn't churn every render. A no-op outside a
 * `<GameCabinet>` (registry is null), so games not yet wrapped are unaffected.
 */
export function useRegisterCabinet(controller: CabinetController | null): void {
  const registry = useContext(CabinetContext);
  useEffect(() => {
    if (!registry) return;
    registry.register(controller);
    return () => registry.register(null);
  }, [registry, controller]);
}
