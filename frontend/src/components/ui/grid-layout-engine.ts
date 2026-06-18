/**
 * Pure grid-layout math — no React, no DOM. Positions are in grid units
 * (columns × rows), not pixels; the React layer converts to pixels.
 *
 * Behaviour mirrors react-grid-layout's defaults: items collide, get pushed
 * down, and float up to fill vertical gaps ("gravity"). Kept side-effect-free
 * so it can be unit-tested in isolation.
 */

export interface GridItem {
  /** Stable identity; React keys and z-order track this. */
  id: string;
  /** Column of the top-left corner (0-based). */
  x: number;
  /** Row of the top-left corner (0-based). */
  y: number;
  /** Width in columns. */
  w: number;
  /** Height in rows. */
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  /** Static items are never moved by compaction or collision resolution. */
  static?: boolean;
}

export type GridLayout = GridItem[];

export const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

/** Do two items overlap? Items never collide with themselves. */
export function collides(a: GridItem, b: GridItem): boolean {
  if (a.id === b.id) return false;
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

const byRowThenCol = (a: GridItem, b: GridItem): number =>
  a.y - b.y || a.x - b.x;

/** Lowest occupied row + 1 — i.e. the first empty row below everything. */
export function bottom(layout: GridLayout): number {
  return layout.reduce((max, it) => Math.max(max, it.y + it.h), 0);
}

/**
 * Float every item up to the first row where it no longer collides, processing
 * top-to-bottom so upper items settle first. `skipId` leaves one item where it
 * is (used for the item under the cursor during a drag).
 */
export function compact(
  layout: GridLayout,
  skipId: string | null = null,
): GridLayout {
  const settled: GridItem[] = [];
  for (const item of [...layout].sort(byRowThenCol)) {
    const next = { ...item };
    if (!next.static && next.id !== skipId) {
      next.y = 0;
      while (settled.some((other) => collides(other, next))) next.y += 1;
    }
    settled.push(next);
  }
  // Preserve the caller's array order so React keys stay stable across renders.
  return layout.map((it) => settled.find((s) => s.id === it.id) ?? it);
}

/**
 * Cascade-push any item colliding with `moved` straight down, recursively, so a
 * dragged/resized item shoves the stack below it. Mutates `layout` in place;
 * callers pass a cloned array.
 */
export function resolveCollisions(
  layout: GridLayout,
  moved: GridItem,
): GridLayout {
  const colliding = layout
    .filter((o) => o.id !== moved.id && !o.static && collides(o, moved))
    .sort((a, b) => a.y - b.y);
  for (const other of colliding) {
    // Re-check: an earlier push this pass may have already cleared it.
    if (collides(other, moved)) {
      other.y = moved.y + moved.h;
      resolveCollisions(layout, other);
    }
  }
  return layout;
}

/** Move an item to (x, y) in grid units, clamping x to the grid and pushing collisions down. */
export function moveItem(
  layout: GridLayout,
  id: string,
  x: number,
  y: number,
  cols: number,
): GridLayout {
  const next = layout.map((it) => ({ ...it }));
  const moving = next.find((it) => it.id === id);
  if (!moving || moving.static) return layout;
  moving.x = clamp(x, 0, cols - moving.w);
  moving.y = Math.max(0, y);
  resolveCollisions(next, moving);
  return next;
}

/** Resize an item to (w, h), clamped to its min/max and the grid edge, pushing collisions down. */
export function resizeItem(
  layout: GridLayout,
  id: string,
  w: number,
  h: number,
  cols: number,
): GridLayout {
  const next = layout.map((it) => ({ ...it }));
  const target = next.find((it) => it.id === id);
  if (!target || target.static) return layout;
  const minW = target.minW ?? 1;
  const minH = target.minH ?? 1;
  const maxW = Math.min(target.maxW ?? cols, cols - target.x);
  target.w = clamp(w, minW, Math.max(minW, maxW));
  target.h = Math.max(minH, target.maxH ? Math.min(h, target.maxH) : h);
  resolveCollisions(next, target);
  return next;
}

/** First free spot for a new item of size w×h: column 0 at the bottom of the stack. */
export function nextPosition(layout: GridLayout): { x: number; y: number } {
  return { x: 0, y: bottom(layout) };
}

/**
 * Refit a layout to a new column count: shrink any item wider than the grid,
 * pull items that now overflow the right edge back in, then compact. Used when a
 * responsive breakpoint changes the number of columns.
 */
export function fitToColumns(layout: GridLayout, cols: number): GridLayout {
  const clamped = layout.map((it) => {
    const w = Math.min(it.w, cols);
    return { ...it, w, x: clamp(it.x, 0, cols - w) };
  });
  return compact(clamped);
}
