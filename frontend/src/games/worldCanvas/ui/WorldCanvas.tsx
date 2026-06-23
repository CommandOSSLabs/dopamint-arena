import { useEffect, useRef, useState } from "react";
import type { PaintedCell } from "../useWorldCanvasOnchain";
import { CHUNK_SIZE, PALETTE, PALETTE_RGB, WC, ZOOM, TAP_SLOP, FONT_MONO } from "./tokens";

/**
 * The infinite, chunked pixel wall — a single HTML5 canvas with pan (drag),
 * zoom-to-cursor (wheel), and click-to-paint. The world is divided into
 * {@link CHUNK_SIZE}×{@link CHUNK_SIZE} chunks; each resident chunk is rasterized
 * once into its own offscreen canvas and only RE-rasterized when a paint dirties
 * it (dirty-chunk redraw). Each render frame culls to the visible chunk range and
 * blits only those — so cost is bound by what's on screen + what changed this
 * frame, never by the (unbounded) total wall size.
 *
 * Cells live in the parent's append-only `paints` map (keyed by cell); this view
 * is the canonical RENDER store and is updated incrementally: it folds in only
 * paints with a fresh co-signed `seq`, and keeps a pixel even after the parent
 * evicts the cell from its retained set (so the wall never visibly un-paints).
 */

interface View {
  /** Screen px of global pixel (0,0); global px g maps to offset + g*scale. */
  offsetX: number;
  offsetY: number;
  scale: number;
}
interface GlobalCell {
  gx: number;
  gy: number;
}

/** A resident chunk: its color buffer, the RGBA image, and its offscreen tile. */
interface Chunk {
  /** color+1 per cell (0 = unpainted, so the board void shows through). */
  buf: Uint8Array;
  img: ImageData;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/** Floor-divide that works for negative coordinates (chunk of a global pixel). */
function chunkOf(g: number): number {
  return Math.floor(g / CHUNK_SIZE);
}

export function WorldCanvas({
  paints,
  revision,
  selectedColor,
  disabled,
  onPaint,
}: {
  /** Append-only live cells from the tunnel hook (stable identity, mutated in place). */
  paints: ReadonlyMap<string, PaintedCell>;
  /** Bumps whenever `paints` changes; gates the incremental chunk sync. */
  revision: number;
  /** Palette index `[0, 16)` placed on click. */
  selectedColor: number;
  /** True while the tunnel is opening — show a grab cursor, swallow paints. */
  disabled: boolean;
  /** Place one cell: chunk (cx,cy) + in-chunk (x,y) + color → one co-signed move. */
  onPaint: (cx: bigint, cy: bigint, x: number, y: number, color: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ offsetX: 0, offsetY: 0, scale: 10 });
  const hover = useRef<GlobalCell | null>(null);
  const fitted = useRef(false);

  // Render store: chunkKey ("cx,cy") → resident chunk, plus the set dirtied since
  // the last frame and the highest co-signed seq already folded in.
  const chunks = useRef<Map<string, Chunk>>(new Map());
  const dirty = useRef<Set<string>>(new Set());
  const appliedSeq = useRef(0);
  const syncedRevision = useRef(-1);

  const selColorRef = useRef(selectedColor);
  selColorRef.current = selectedColor;
  const paintsRef = useRef(paints);
  paintsRef.current = paints;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;

  const [hud, setHud] = useState<{ zoom: number; cell: GlobalCell | null }>({
    zoom: 10,
    cell: null,
  });

  const cellAt = (sx: number, sy: number): GlobalCell => {
    const v = view.current;
    return {
      gx: Math.floor((sx - v.offsetX) / v.scale),
      gy: Math.floor((sy - v.offsetY) / v.scale),
    };
  };

  // Materialize a chunk (offscreen 256×256 tile) on first paint into it.
  const ensureChunk = (key: string): Chunk | null => {
    let c = chunks.current.get(key);
    if (c) return c;
    const canvas = document.createElement("canvas");
    canvas.width = CHUNK_SIZE;
    canvas.height = CHUNK_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    c = {
      buf: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE),
      img: ctx.createImageData(CHUNK_SIZE, CHUNK_SIZE),
      canvas,
      ctx,
    };
    chunks.current.set(key, c);
    return c;
  };

  // Fold every paint with a never-seen co-signed seq into its chunk's buffer +
  // RGBA image (O(1) per new cell), marking the chunk dirty. Gated on `revision`
  // so the map is scanned at most once per change, not once per render frame.
  const syncPaints = () => {
    if (syncedRevision.current === revisionRef.current) return;
    syncedRevision.current = revisionRef.current;
    let maxSeq = appliedSeq.current;
    for (const cell of paintsRef.current.values()) {
      if (cell.seq <= appliedSeq.current) continue;
      if (cell.seq > maxSeq) maxSeq = cell.seq;
      const cx = Number(cell.cx);
      const cy = Number(cell.cy);
      const key = `${cx},${cy}`;
      const chunk = ensureChunk(key);
      if (!chunk) continue;
      const idx = cell.y * CHUNK_SIZE + cell.x;
      chunk.buf[idx] = cell.color + 1;
      const [r, g, b] = PALETTE_RGB[cell.color] ?? [255, 255, 255];
      const o = idx * 4;
      chunk.img.data[o] = r;
      chunk.img.data[o + 1] = g;
      chunk.img.data[o + 2] = b;
      chunk.img.data[o + 3] = 255;
      dirty.current.add(key);
    }
    appliedSeq.current = maxSeq;
  };

  // Continuous render loop: sync new paints, re-rasterize dirty tiles, then cull
  // to the visible chunk range and blit only those.
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
      // Center the origin chunk on first sight; never snap back during play.
      if (cw > 0 && !fitted.current) {
        view.current.offsetX = cw / 2;
        view.current.offsetY = ch / 2;
        fitted.current = true;
      }

      syncPaints();

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const v = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;

      // Re-rasterize tiles dirtied since the last frame (bound by paints/frame).
      for (const key of dirty.current) {
        const c = chunks.current.get(key);
        if (c) c.ctx.putImageData(c.img, 0, 0);
      }
      dirty.current.clear();

      // Backdrop: the whole viewport is the empty canvas void; painted chunks
      // are blitted on top.
      ctx.fillStyle = WC.bg;
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = WC.board;
      ctx.fillRect(0, 0, cw, ch);

      // Visible global-pixel bounds → visible chunk range (viewport culling).
      const gMinX = (0 - v.offsetX) / v.scale;
      const gMinY = (0 - v.offsetY) / v.scale;
      const gMaxX = (cw - v.offsetX) / v.scale;
      const gMaxY = (ch - v.offsetY) / v.scale;
      const cMinX = chunkOf(gMinX);
      const cMinY = chunkOf(gMinY);
      const cMaxX = chunkOf(gMaxX);
      const cMaxY = chunkOf(gMaxY);
      const tile = CHUNK_SIZE * v.scale;
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        for (let cy = cMinY; cy <= cMaxY; cy++) {
          const c = chunks.current.get(`${cx},${cy}`);
          if (!c) continue;
          const sx = v.offsetX + cx * CHUNK_SIZE * v.scale;
          const sy = v.offsetY + cy * CHUNK_SIZE * v.scale;
          ctx.drawImage(c.canvas, sx, sy, tile, tile);
        }
      }

      // Chunk borders + a faint per-cell grid once zoomed in enough to read.
      if (v.scale >= 8) {
        ctx.strokeStyle = WC.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const px0 = chunkOf(gMinX) * CHUNK_SIZE;
        const py0 = chunkOf(gMinY) * CHUNK_SIZE;
        for (let gx = px0; gx <= gMaxX; gx++) {
          const sx = Math.round(v.offsetX + gx * v.scale) + 0.5;
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, ch);
        }
        for (let gy = py0; gy <= gMaxY; gy++) {
          const sy = Math.round(v.offsetY + gy * v.scale) + 0.5;
          ctx.moveTo(0, sy);
          ctx.lineTo(cw, sy);
        }
        ctx.stroke();
      }

      // Ghost preview of the selected color under the cursor + hover outline.
      const hc = hover.current;
      if (hc) {
        const px = Math.floor(v.offsetX + hc.gx * v.scale);
        const py = Math.floor(v.offsetY + hc.gy * v.scale);
        const pw = Math.floor(v.offsetX + (hc.gx + 1) * v.scale) - px;
        const ph = Math.floor(v.offsetY + (hc.gy + 1) * v.scale) - py;
        if (!disabled) {
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = PALETTE[selColorRef.current] ?? "#fff";
          ctx.fillRect(px, py, pw, ph);
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = WC.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
      }

      const now = performance.now();
      if (now - lastHud > 100) {
        lastHud = now;
        setHud((prev) => {
          const cell = hover.current;
          if (
            prev.zoom === v.scale &&
            prev.cell?.gx === cell?.gx &&
            prev.cell?.gy === cell?.gy
          )
            return prev;
          return { zoom: v.scale, cell };
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [disabled]);

  // Drag pans; a tap (no pan) places a pixel.
  const drag = useRef<{
    lastX: number;
    lastY: number;
    moved: number;
    panning: boolean;
  } | null>(null);

  const localXY = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  const placeAt = (cell: GlobalCell) => {
    const cx = chunkOf(cell.gx);
    const cy = chunkOf(cell.gy);
    onPaint(
      BigInt(cx),
      BigInt(cy),
      cell.gx - cx * CHUNK_SIZE,
      cell.gy - cy * CHUNK_SIZE,
      selColorRef.current,
    );
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const { sx, sy } = localXY(e);
    drag.current = { lastX: sx, lastY: sy, moved: 0, panning: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const { sx, sy } = localXY(e);
    hover.current = cellAt(sx, sy);
    const d = drag.current;
    if (!d) return;
    const dx = sx - d.lastX;
    const dy = sy - d.lastY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    if (d.moved > TAP_SLOP) d.panning = true;
    if (d.panning) {
      view.current.offsetX += dx;
      view.current.offsetY += dy;
    }
    d.lastX = sx;
    d.lastY = sy;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.panning || disabled) return;
    const { sx, sy } = localXY(e);
    placeAt(cellAt(sx, sy));
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
          cursor: disabled ? "grab" : "crosshair",
          imageRendering: "pixelated",
        }}
      />
      {/* Zoom HUD (bottom-left) */}
      <div
        className="absolute bottom-[18px] left-4 flex items-center gap-2 px-2.5 py-1.5 rounded-[12px]"
        style={{
          background: "rgba(10,16,34,0.66)",
          border: "1px solid rgba(255,255,255,0.12)",
          backdropFilter: "blur(8px)",
        }}
      >
        <ZoomButton label="−" onClick={() => zoomBy(1 / ZOOM.step)} />
        <span
          className="min-w-[46px] text-center text-xs font-bold tabular-nums"
          style={{ color: WC.text, fontFamily: FONT_MONO }}
        >
          {Math.round((hud.zoom / 10) * 100)}%
        </span>
        <ZoomButton label="+" onClick={() => zoomBy(ZOOM.step)} />
        <ZoomButton label="⊙" onClick={() => (fitted.current = false)} />
        <span
          className="ml-0.5 min-w-[74px] text-[11px] tabular-nums"
          style={{ color: WC.muted, fontFamily: FONT_MONO }}
        >
          {hud.cell ? `${hud.cell.gx},${hud.cell.gy}` : "—"}
        </span>
      </div>
    </div>
  );
}

function ZoomButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] text-[15px] font-bold leading-none"
      style={{ background: "rgba(255,255,255,0.08)", color: WC.text }}
    >
      {label}
    </button>
  );
}
