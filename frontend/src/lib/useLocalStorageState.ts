import { useEffect, useState } from "react";

/**
 * `useState` that mirrors to localStorage under `key`. Reads the stored value on
 * first render and writes back whenever it changes. Falls back to `initial` when
 * nothing is stored or the read/parse fails (e.g. private mode, corrupt JSON).
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

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // ignore — persistence is best-effort
    }
  }, [key, state]);

  return [state, setState] as const;
}
