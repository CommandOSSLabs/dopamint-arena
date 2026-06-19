/**
 * Per-window teardown registry.
 *
 * A game's live session (state, timers, a PvP WebSocket + tunnel) is kept in a
 * module store keyed by `windowId`, NOT in component state — so it survives the
 * component unmounting when a window is minimized, maximized/floated, or the
 * desktop reflows across a breakpoint (see ADR 0003 / the Desktop remount paths).
 * The catch: the session must still be torn down when the window is genuinely
 * CLOSED, and only the desktop knows that. Registrants add a disposer here on
 * creation; `Desktop.close(id)` calls {@link disposeWindow} to run them all.
 *
 * Disposers are keyed (e.g. `"battleship-pvp"`, `"battleship-mode"`) so one
 * window can hold several — and re-registering the same key across remounts just
 * replaces it, rather than piling up duplicates.
 */

const disposers = new Map<string, Map<string, () => void>>();

/** Register (or replace, by `key`) a teardown for a window. */
export function registerWindowDisposer(
  windowId: string,
  key: string,
  dispose: () => void,
): void {
  let forWindow = disposers.get(windowId);
  if (!forWindow) {
    forWindow = new Map();
    disposers.set(windowId, forWindow);
  }
  forWindow.set(key, dispose);
}

/** Run and forget every disposer for a window — call when it is truly closed. */
export function disposeWindow(windowId: string): void {
  const forWindow = disposers.get(windowId);
  if (!forWindow) return;
  disposers.delete(windowId);
  for (const dispose of forWindow.values()) dispose();
}
