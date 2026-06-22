/**
 * DraggablePanel — a floating glass panel the user can drag off the canvas.
 *
 * Renders `children` absolutely positioned inside its parent (which must be
 * `position: relative`), starting at `defaultX`/`defaultY`. A pointerdown
 * anywhere on the panel chrome (except elements opting out via
 * `data-no-drag`) begins a drag: we track the pointer delta and translate the
 * panel, clamping its top-left so the panel always stays fully inside the
 * parent's bounds (the board). The panel keeps its own width — pass it via the
 * wrapped content's layout (or `width`) so clamping has a real footprint.
 *
 * Why pointer events (not mouse/touch): one unified stream + pointer capture so
 * a fast drag that leaves the panel doesn't drop the gesture. The drag offset
 * lives in a ref during the move and is committed to state on each frame via a
 * rAF, so we re-render at most once per frame.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DUEL, glass } from "./tokens";

interface DraggablePanelProps {
  /**
   * Initial top-left in px relative to the parent's top-left. With
   * `anchor: "right"`, `defaultX` is instead the inset from the parent's RIGHT
   * edge (resolved to a left coordinate against the live parent width on mount).
   */
  defaultX: number;
  defaultY: number;
  /** Which edge `defaultX` is measured from. Default "left". */
  anchor?: "left" | "right";
  /** Panel width in px — also used to clamp the right edge inside the board. */
  width: number;
  /** Extra inset (px) kept between the panel and the parent edges when clamping. */
  margin?: number;
  /** Short label shown when collapsed to a thin bar (still draggable). */
  collapsedLabel?: string;
  children: React.ReactNode;
}

/** Clamp `v` into `[lo, hi]`, tolerating an inverted range (parent smaller than panel). */
function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function DraggablePanel({
  defaultX,
  defaultY,
  anchor = "left",
  width,
  margin = 8,
  collapsedLabel,
  children,
}: DraggablePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  // For a left anchor the start x is `defaultX`. A right anchor is resolved
  // against the live parent width after mount (so the panel hugs the right edge
  // however wide the board is); until then it renders off-screen-safe at defaultX.
  const [pos, setPos] = useState({ x: defaultX, y: defaultY });
  const placedRef = useRef(false);

  // Live drag bookkeeping: pointer origin + the panel position when the drag
  // began, so the new position is origin + (pointer - pointerOrigin), clamped.
  const dragRef = useRef<{
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);

  const clampToParent = useCallback(
    (x: number, y: number) => {
      const el = panelRef.current;
      const parent = el?.offsetParent as HTMLElement | null;
      const pw = parent?.clientWidth ?? Infinity;
      const ph = parent?.clientHeight ?? Infinity;
      const h = el?.offsetHeight ?? 0;
      return {
        x: clamp(x, margin, pw - width - margin),
        y: clamp(y, margin, ph - h - margin),
      };
    },
    [width, margin],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Let interactive children (buttons, links) opt out of starting a drag.
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        startX: pos.x,
        startY: pos.y,
      };
    },
    [pos.x, pos.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const nx = d.startX + (e.clientX - d.pointerX);
      const ny = d.startY + (e.clientY - d.pointerY);
      if (rafRef.current != null) return; // already a frame queued
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setPos(clampToParent(nx, ny));
      });
    },
    [clampToParent],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Resolve the initial position once the parent has measurable bounds: a right
  // anchor maps `defaultX` (inset from the right) to a left coordinate, and we
  // clamp so the panel starts fully inside the board regardless of anchor. If the
  // parent isn't laid out yet (clientWidth 0), retry next frame rather than
  // stranding the panel at its pre-measure default.
  useEffect(() => {
    let raf = 0;
    const place = () => {
      if (placedRef.current) return;
      const parent = panelRef.current?.offsetParent as HTMLElement | null;
      if (!parent || parent.clientWidth === 0) {
        raf = requestAnimationFrame(place); // not laid out yet — try next frame
        return;
      }
      placedRef.current = true;
      const startX =
        anchor === "right" ? parent.clientWidth - width - defaultX : defaultX;
      setPos(clampToParent(startX, defaultY));
    };
    place();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [anchor, defaultX, defaultY, width, clampToParent]);

  // Cancel any queued frame on unmount so we never setState after teardown.
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return (
    <div
      ref={panelRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="absolute touch-none select-none rounded-[14px]"
      style={{
        ...glass,
        left: pos.x,
        top: pos.y,
        width,
        cursor: "grab",
      }}
    >
      {/* Collapse / expand toggle — opts out of dragging so the click registers. */}
      <button
        data-no-drag
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "Expand panel" : "Collapse panel"}
        className="absolute right-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-md text-xs font-bold leading-none"
        style={{ background: "rgba(255,255,255,0.1)", color: DUEL.muted }}
      >
        {collapsed ? "+" : "–"}
      </button>
      {collapsed ? (
        <div
          className="px-3 py-2 pr-8 text-[11px] font-extrabold uppercase tracking-wider"
          style={{ color: DUEL.muted }}
        >
          {collapsedLabel ?? "Panel"}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
