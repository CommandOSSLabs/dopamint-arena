import { useEffect, useRef, useState } from "react";

/** Trailing-debounce window for writes: a continuous drag updates state ~60×/s, but
 *  persistence only needs the resting value — so we collapse the burst to one write. */
const WRITE_DEBOUNCE_MS = 200;

/**
 * `useState` that mirrors to localStorage under `key`. Reads the stored value on
 * first render and writes back whenever it changes. Falls back to `initial` when
 * nothing is stored or the read/parse fails (e.g. private mode, corrupt JSON).
 *
 * Writes are debounced: dragging a window (which calls the setter every frame) would
 * otherwise hammer synchronous localStorage I/O on the main thread. The latest value
 * is flushed on unmount so a position changed right before close isn't lost.
 */
export function useLocalStorageState<T>(key: string, initial: T | (() => T)) {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return JSON.parse(stored) as T;
    } catch {
      // ignore — fall through to the default
    }
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });

  // Reachable from the unmount flush without re-subscribing the effect on every change.
  const latest = useRef(state);
  latest.current = state;

  // Debounced write: rapid updates collapse to a single localStorage write once they
  // settle, instead of one per frame.
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(latest.current));
      } catch {
        // ignore — persistence is best-effort
      }
    }, WRITE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [key, state]);

  // Flush the pending value if we unmount mid-debounce (e.g. tab closed during a drag).
  useEffect(() => {
    return () => {
      try {
        localStorage.setItem(key, JSON.stringify(latest.current));
      } catch {
        // ignore
      }
    };
  }, [key]);

  return [state, setState] as const;
}
