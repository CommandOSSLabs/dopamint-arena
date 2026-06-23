import type { CrossDirection } from "./crossSceneTypes.ts";

const KEY_DIRS: Record<string, CrossDirection> = {
  ArrowUp: "north",
  KeyW: "north",
  ArrowDown: "south",
  KeyS: "south",
  ArrowLeft: "west",
  KeyA: "west",
  ArrowRight: "east",
  KeyD: "east",
};

/** Keyboard code → screen-relative direction (null for unhandled keys). */
export function keyToScreenDir(code: string): CrossDirection | null {
  return KEY_DIRS[code] ?? null;
}

/** Swipe vector → screen-relative direction; null if neither axis clears `threshold`. */
export function swipeToScreenDir(
  dx: number,
  dy: number,
  threshold = 28,
): CrossDirection | null {
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "east" : "west";
  return dy > 0 ? "south" : "north";
}

/**
 * Binds keyboard + touch-swipe input scoped to `target` (never `window`).
 * Returns an unbind function that removes every listener — call it on teardown.
 */
export function bindCrossInput(
  target: HTMLElement,
  onScreenDir: (dir: CrossDirection) => void,
): () => void {
  const onKey = (e: KeyboardEvent) => {
    const dir = keyToScreenDir(e.code);
    if (dir) {
      e.preventDefault();
      onScreenDir(dir);
    }
  };
  let startX = 0;
  let startY = 0;
  const onTouchStart = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    startX = t.clientX;
    startY = t.clientY;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    const dir = swipeToScreenDir(t.clientX - startX, t.clientY - startY);
    if (dir) onScreenDir(dir);
  };

  target.tabIndex = target.tabIndex >= 0 ? target.tabIndex : 0; // focusable for keydown
  target.addEventListener("keydown", onKey);
  target.addEventListener("touchstart", onTouchStart, { passive: true });
  target.addEventListener("touchend", onTouchEnd);

  return () => {
    target.removeEventListener("keydown", onKey);
    target.removeEventListener("touchstart", onTouchStart);
    target.removeEventListener("touchend", onTouchEnd);
  };
}
