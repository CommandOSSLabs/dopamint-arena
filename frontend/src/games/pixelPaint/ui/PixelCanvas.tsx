import { useEffect, useRef, useState } from "react";
import type { PixelPaintState } from "sui-tunnel-ts/protocol/pixelPaint";
import { colorHex } from "../palette";
import { DUEL, ZOOM, TAP_SLOP, glass } from "./tokens";

/**
 * The shared pixel wall — a single HTML5 canvas with pan, zoom-to-cursor, a ghost
 * preview of the selected color under the cursor, and a hover outline. Flat
 * (orthographic) r/place rendering for crisp pixels and exact hit-testing. A
 * continuous rAF loop redraws so live bot strokes appear without prop churn.
 */

interface View {
  offsetX: number;
  offsetY: number;
  scale: number;
}
interface Cell {
  x: number;
  y: number;
}

export function PixelCanvas({
  state,
  ghostColor,
  disabled,
  onPlace,
  onStamp,
  tool = "pan",
  guide,
  reveal,
  blocked,
}: {
  state: PixelPaintState;
  /** Hex of the color to preview under the cursor, or null to hide the ghost. */
  ghostColor: string | null;
  disabled: boolean;
  onPlace: (x: number, y: number) => void;
  /** Plant a whole art design centered on the tapped cell (stamp tool). */
  onStamp?: (x: number, y: number) => void;
  /** "draw" = left-drag paints; "stamp" = tap plants a design; "pan" = drag pans, tap places. */
  tool?: "draw" | "pan" | "stamp";
  /**
   * Faint paint-by-numbers stencil drawn UNDER the live cells (length
   * width*height; 0 = no hint, else target color index). Used in Duel mode to
   * show YOUR secret shape only — never the opponent's.
   */
  guide?: Uint8Array;
  /**
   * FOG-OF-WAR visibility mask (length width*height; 1 = visible, 0 = fogged).
   * When provided (vs-bot human view) a painted cell renders ONLY where
   * `reveal[idx] === 1` — the viewer's own cells plus cells revealed by an
   * attack; every other painted cell is hidden behind the board "wall" so the
   * opponent's secret builds stay invisible. Omit (auto/spectator god-view) to
   * render the whole canvas as today. Backward-compatible.
   */
  reveal?: Uint8Array;
  /**
   * BLOCKED mask (length width*height; 1 = a landed attack that sits in the
   * foe's shape — a HIT). Such cells render with a vivid red border + tint so a
   * successful strike pops apart from gray misses and colored builds. Honors the
   * `reveal` fog: a blocked cell the viewer can't see stays hidden. Omit to draw
   * nothing extra. Backward-compatible.
   */
  blocked?: Uint8Array;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ offsetX: 0, offsetY: 0, scale: 8 });
  const hover = useRef<Cell | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ghostRef = useRef(ghostColor);
  ghostRef.current = ghostColor;
  const guideRef = useRef(guide);
  guideRef.current = guide;
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const fitted = useRef(false);

  const [hud, setHud] = useState<{ zoom: number; cell: Cell | null }>({
    zoom: 8,
    cell: null,
  });

  // Refit detection (handled inside the render loop, not as an effect dep): a
  // session reset drops `placed` back down, and board dims may change. Tracking
  // them here keeps the render effect stable (no re-subscribe per bot move) while
  // still re-centering on reset — without snapping the view back during play.
  const prevPlaced = useRef(-1);
  const prevDims = useRef("");

  const cellAt = (sx: number, sy: number): Cell => {
    const v = view.current;
    return {
      x: Math.floor((sx - v.offsetX) / v.scale),
      y: Math.floor((sy - v.offsetY) / v.scale),
    };
  };

  // Continuous render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let raf = 0;
    let lastHud = 0;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
        canvas.style.width = `${cw}px`;
        canvas.style.height = `${ch}px`;
      }
      // Fit on first sight, on a session reset (placed count drops), or on a
      // dimension change — never on a normal increasing-placed frame, so live
      // play preserves the user's pan/zoom.
      const sf = stateRef.current;
      const dims = `${sf.width}x${sf.height}`;
      if (
        cw > 0 &&
        (!fitted.current ||
          sf.placed < prevPlaced.current ||
          dims !== prevDims.current)
      ) {
        const scale = Math.max(
          ZOOM.min,
          Math.min(ZOOM.max, Math.min(cw / sf.width, ch / sf.height) * 0.92),
        );
        view.current = {
          scale,
          offsetX: (cw - sf.width * scale) / 2,
          offsetY: (ch - sf.height * scale) / 2,
        };
        fitted.current = true;
      }
      prevPlaced.current = sf.placed;
      prevDims.current = dims;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const s = stateRef.current;
      const v = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;

      // Backdrop + board void.
      ctx.fillStyle = DUEL.bg;
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = DUEL.board;
      ctx.fillRect(v.offsetX, v.offsetY, s.width * v.scale, s.height * v.scale);

      // Visible cell range (cull off-screen cells).
      const x0 = Math.max(0, Math.floor((0 - v.offsetX) / v.scale));
      const y0 = Math.max(0, Math.floor((0 - v.offsetY) / v.scale));
      const x1 = Math.min(s.width, Math.ceil((cw - v.offsetX) / v.scale));
      const y1 = Math.min(s.height, Math.ceil((ch - v.offsetY) / v.scale));

      // Faint paint-by-numbers guide UNDER the live cells: only where the cell is
      // still empty, so it reads as "remaining work" and never muddies painted
      // pixels. Drawn at low alpha in the target color.
      const g = guideRef.current;
      if (g) {
        ctx.globalAlpha = 0.25;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const idx = y * s.width + x;
            const want = g[idx];
            if (want === 0 || s.canvas[idx] !== 0) continue;
            const px = Math.floor(v.offsetX + x * v.scale);
            const py = Math.floor(v.offsetY + y * v.scale);
            const pw = Math.floor(v.offsetX + (x + 1) * v.scale) - px;
            const ph = Math.floor(v.offsetY + (y + 1) * v.scale) - py;
            ctx.fillStyle = colorHex(want);
            ctx.fillRect(px, py, pw, ph);
          }
        }
        ctx.globalAlpha = 1;
      }

      // FOG: when a visibility mask is supplied, a painted cell renders only
      // where the mask says it's visible; everywhere else it falls back to the
      // board wall, hiding the opponent's secret builds.
      const fog = revealRef.current;
      const bk = blockedRef.current;
      const locked = s.overwriteLimit;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = y * s.width + x;
          const c = s.canvas[idx];
          if (c === 0) continue; // empty stays board color
          if (fog && fog[idx] === 0) continue; // fogged — render as wall
          // Integer-snapped tiling: cells share exact pixel edges, so there are
          // no anti-aliasing gaps and no color bleed at any zoom level.
          const px = Math.floor(v.offsetX + x * v.scale);
          const py = Math.floor(v.offsetY + y * v.scale);
          const pw = Math.floor(v.offsetX + (x + 1) * v.scale) - px;
          const ph = Math.floor(v.offsetY + (y + 1) * v.scale) - py;
          ctx.fillStyle = colorHex(c);
          ctx.fillRect(px, py, pw, ph);
          // A LOCKED (secured) cell gets an inset border in its owner's tint —
          // shows whose territory is permanent and can no longer be overwritten.
          if (s.paints[idx] >= locked && v.scale >= 4) {
            ctx.strokeStyle = s.owner[idx] === 1 ? DUEL.seatA : DUEL.seatB;
            ctx.lineWidth = Math.max(1, v.scale * 0.14);
            const o = ctx.lineWidth / 2;
            ctx.strokeRect(
              px + o,
              py + o,
              pw - ctx.lineWidth,
              ph - ctx.lineWidth,
            );
          }
          // HIT: a landed attack sitting in the foe's shape (blocked) gets a red
          // wash + border so it stands out from gray misses and colored builds.
          // The fog `continue` above already kept this to cells the viewer sees.
          if (bk && bk[idx] === 1) {
            ctx.fillStyle = DUEL.hitTint;
            ctx.fillRect(px, py, pw, ph);
            ctx.strokeStyle = DUEL.hit;
            ctx.lineWidth = Math.max(1.5, v.scale * 0.2);
            const ro = ctx.lineWidth / 2;
            ctx.strokeRect(
              px + ro,
              py + ro,
              pw - ctx.lineWidth,
              ph - ctx.lineWidth,
            );
          }
        }
      }

      // Grid when zoomed in enough to be legible.
      if (v.scale >= 7) {
        ctx.strokeStyle = DUEL.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = x0; x <= x1; x++) {
          const sx = Math.round(v.offsetX + x * v.scale) + 0.5;
          ctx.moveTo(sx, v.offsetY + y0 * v.scale);
          ctx.lineTo(sx, v.offsetY + y1 * v.scale);
        }
        for (let y = y0; y <= y1; y++) {
          const sy = Math.round(v.offsetY + y * v.scale) + 0.5;
          ctx.moveTo(v.offsetX + x0 * v.scale, sy);
          ctx.lineTo(v.offsetX + x1 * v.scale, sy);
        }
        ctx.stroke();
      }

      // Ghost preview + hover outline.
      const hc = hover.current;
      if (hc && hc.x >= 0 && hc.x < s.width && hc.y >= 0 && hc.y < s.height) {
        const px = Math.floor(v.offsetX + hc.x * v.scale);
        const py = Math.floor(v.offsetY + hc.y * v.scale);
        const pw = Math.floor(v.offsetX + (hc.x + 1) * v.scale) - px;
        const ph = Math.floor(v.offsetY + (hc.y + 1) * v.scale) - py;
        if (!disabled && ghostRef.current) {
          ctx.globalAlpha = 0.55;
          ctx.fillStyle = ghostRef.current;
          ctx.fillRect(px, py, pw, ph);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = DUEL.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
      }

      // Throttle HUD state updates to ~10fps.
      const now = performance.now();
      if (now - lastHud > 100) {
        lastHud = now;
        setHud((prev) => {
          const zoom = v.scale;
          const cell = hover.current;
          if (
            prev.zoom === zoom &&
            prev.cell?.x === cell?.x &&
            prev.cell?.y === cell?.y
          )
            return prev;
          return { zoom, cell };
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [disabled]);

  // Pointer interactions. tool="draw": left-drag paints a stroke (pan with
  // middle/right button); tool="pan": left-drag pans, a tap places.
  const drag = useRef<{
    lastX: number;
    lastY: number;
    moved: number;
    panning: boolean;
    mode: "draw" | "pan";
    lastPaint: string | null;
  } | null>(null);

  const localXY = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  const paintCell = (c: Cell) => {
    const s = stateRef.current;
    if (c.x >= 0 && c.x < s.width && c.y >= 0 && c.y < s.height)
      onPlace(c.x, c.y);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const { sx, sy } = localXY(e);
    // Left button + draw tool paints; any other button (or pan tool) pans.
    const wantDraw = tool === "draw" && !disabled && e.button === 0;
    drag.current = {
      lastX: sx,
      lastY: sy,
      moved: 0,
      panning: false,
      mode: wantDraw ? "draw" : "pan",
      lastPaint: null,
    };
    if (wantDraw) {
      const c = cellAt(sx, sy);
      paintCell(c);
      drag.current.lastPaint = `${c.x},${c.y}`;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const { sx, sy } = localXY(e);
    hover.current = cellAt(sx, sy);
    const d = drag.current;
    if (!d) return;
    const dx = sx - d.lastX;
    const dy = sy - d.lastY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    if (d.mode === "draw") {
      const c = cellAt(sx, sy);
      const key = `${c.x},${c.y}`;
      if (key !== d.lastPaint) {
        paintCell(c);
        d.lastPaint = key;
      }
    } else {
      if (d.moved > TAP_SLOP) d.panning = true;
      if (d.panning) {
        view.current.offsetX += dx;
        view.current.offsetY += dy;
      }
    }
    d.lastX = sx;
    d.lastY = sy;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // A tap (no pan): stamp a design, or place a single pixel.
    if (d.mode === "pan" && !d.panning && !disabled) {
      const { sx, sy } = localXY(e);
      const c = cellAt(sx, sy);
      const s = stateRef.current;
      if (c.x < 0 || c.x >= s.width || c.y < 0 || c.y >= s.height) return;
      if (tool === "stamp" && onStamp) onStamp(c.x, c.y);
      else paintCell(c);
    }
  };
  const onPointerLeave = () => {
    hover.current = null;
    drag.current = null;
  };

  const zoomBy = (factor: number, sx?: number, sy?: number) => {
    const v = view.current;
    const wrap = wrapRef.current!;
    const ax = sx ?? wrap.clientWidth / 2;
    const ay = sy ?? wrap.clientHeight / 2;
    const next = Math.max(ZOOM.min, Math.min(ZOOM.max, v.scale * factor));
    const f = next / v.scale;
    v.offsetX = ax * (1 - f) + v.offsetX * f;
    v.offsetY = ay * (1 - f) + v.offsetY * f;
    v.scale = next;
  };
  const onWheel = (e: React.WheelEvent) => {
    const { sx, sy } = localXY(e);
    zoomBy(e.deltaY < 0 ? ZOOM.step : 1 / ZOOM.step, sx, sy);
  };

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        style={{
          touchAction: "none",
          cursor: disabled
            ? "grab"
            : tool === "draw"
              ? "crosshair"
              : tool === "stamp"
                ? "copy"
                : "grab",
          imageRendering: "pixelated",
        }}
      />
      {/* Zoom HUD (bottom-left) */}
      <div
        className="absolute bottom-[18px] left-4 flex items-center gap-2 rounded-[14px] px-2.5 py-1.5"
        style={glass}
      >
        <ZoomButton label="−" onClick={() => zoomBy(1 / ZOOM.step)} />
        <span
          className="min-w-[42px] text-center text-xs font-bold tabular-nums"
          style={{ color: DUEL.text }}
        >
          {Math.round((hud.zoom / 8) * 100)}%
        </span>
        <ZoomButton label="+" onClick={() => zoomBy(ZOOM.step)} />
        <ZoomButton
          label="⊙"
          onClick={() => {
            fitted.current = false;
          }}
        />
        <span
          className="ml-1 w-[64px] text-[11px] tabular-nums"
          style={{ color: DUEL.muted }}
        >
          {hud.cell ? `${hud.cell.x},${hud.cell.y}` : "—"}
        </span>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-md text-sm font-extrabold leading-none"
      style={{ background: "rgba(255,255,255,0.08)", color: DUEL.text }}
    >
      {label}
    </button>
  );
}
