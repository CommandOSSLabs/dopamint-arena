import { useEffect, useRef, useState } from "react";
import {
  cellKey,
  type PaintedCell,
  type AgentMarker,
  type CanvasFocus,
} from "../useWorldCanvasOnchain";
import {
  CHUNK_SIZE,
  PALETTE,
  PALETTE_RGB,
  WC,
  ZOOM,
  TAP_SLOP,
  FONT_MONO,
  FONT_DISPLAY,
  shortAddress,
} from "./tokens";

/** Camera zoom used when jumping to a freshly spawned agent's flag. */
const FOCUS_SCALE = 12;

/**
 * The infinite, chunked pixel wall — a single HTML5 canvas with pan (drag),
 * zoom-to-cursor (wheel), and drag-to-paint. The world is divided into
 * {@link CHUNK_SIZE}×{@link CHUNK_SIZE} chunks; each resident chunk is rasterized
 * once into its own offscreen canvas and only RE-rasterized when a paint dirties
 * it (dirty-chunk redraw). Each render frame culls to the visible chunk range and
 * blits only those — so cost is bound by what's on screen + what changed this
 * frame, never by the (unbounded) total wall size.
 *
 * Render is deliberately LEAN: crisp tile blits, flat strokes, a 1px brush-
 * footprint outline, and a small agent pin. No glow ribbons, supersampling,
 * halos, or soft-dab fields — the chunk store + viewport culling is the only
 * machinery, so several agents stay at a smooth 60fps.
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

/**
 * Bresenham line rasterization between two cells (both endpoints inclusive). A drag
 * only delivers discrete pointer samples; at speed those samples can be many cells
 * apart. Walking the line between successive samples lays a gap-free trail, so a
 * fast flick still paints a continuous stroke instead of a dotted one.
 */
function interpolateCells(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): GlobalCell[] {
  const cells: GlobalCell[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    cells.push({ gx: x, gy: y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return cells;
}

export function WorldCanvas({
  paints,
  revision,
  selectedColor,
  brushSize,
  panOnly,
  disabled,
  onPaint,
  agents,
  focus,
  humanAddress,
}: {
  /** Append-only live cells from the tunnel hook (stable identity, mutated in place). */
  paints: ReadonlyMap<string, PaintedCell>;
  /** Bumps whenever `paints` changes; gates the incremental chunk sync. */
  revision: number;
  /** Palette index `[0, 16)` placed on drag. */
  selectedColor: number;
  /** Brush footprint edge in cells (1/2/3): each sampled point paints an N×N block. */
  brushSize: number;
  /** Hand tool: a left-drag pans instead of painting (still paints with no tool). */
  panOnly: boolean;
  /** True while the tunnel is opening — show a grab cursor, swallow paints. */
  disabled: boolean;
  /** Place one cell: chunk (cx,cy) + in-chunk (x,y) + color → one co-signed move. */
  onPaint: (cx: bigint, cy: bigint, x: number, y: number, color: number) => void;
  /** Live agents — drawn as small on-canvas pins above the flag each is painting. */
  agents: AgentMarker[];
  /** Latest camera-jump request; the view eases to center this point on change. */
  focus: CanvasFocus | null;
  /** The human's address, so a hovered cell the human painted reads "You". */
  humanAddress: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ offsetX: 0, offsetY: 0, scale: 10 });
  const hover = useRef<GlobalCell | null>(null);
  const fitted = useRef(false);
  // Latest agents/human for the render loop (refs so the loop never re-subscribes).
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const humanRef = useRef(humanAddress);
  humanRef.current = humanAddress;
  // Active camera-jump target (global-pixel center + scale); cleared on arrival or
  // when the user pans/zooms, so a jump never fights manual control.
  const focusTarget = useRef<{ gcx: number; gcy: number; scale: number } | null>(
    null,
  );

  // Render store: chunkKey ("cx,cy") → resident chunk, plus the set dirtied since
  // the last frame and the highest co-signed seq already folded in.
  const chunks = useRef<Map<string, Chunk>>(new Map());
  const dirty = useRef<Set<string>>(new Set());
  const appliedSeq = useRef(0);
  const syncedRevision = useRef(-1);
  // Global-pixel bounding box of every painted cell, grown as paints fold in.
  // Drives the ⊙ "fit to content" reset so a recenter never lands on a blank void.
  const bbox = useRef<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null>(null);

  const selColorRef = useRef(selectedColor);
  selColorRef.current = selectedColor;
  const brushSizeRef = useRef(brushSize);
  brushSizeRef.current = brushSize;
  const panOnlyRef = useRef(panOnly);
  panOnlyRef.current = panOnly;
  const paintsRef = useRef(paints);
  paintsRef.current = paints;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;

  // Cells already painted in the active pointer stroke. A drag interpolates and
  // overlaps brush blocks, so this set keeps every cell to exactly ONE co-signed
  // move (no wasted/duplicate co-signs within a single stroke). Cleared on stroke end.
  const strokeSet = useRef<Set<string>>(new Set());
  // Hold Space to pan with a left-drag instead of painting (paint-app convention),
  // so panning stays reachable without surrendering left-drag as the brush.
  const spacePressed = useRef(false);

  const [hud, setHud] = useState<{
    zoom: number;
    cell: GlobalCell | null;
    /** Floating owner label for the hovered painted cell ("You" / "owner …"). */
    owner: { label: string; sx: number; sy: number } | null;
  }>({ zoom: 10, cell: null, owner: null });

  // A new focus request (agent spawn) sets a camera target the draw loop eases to.
  useEffect(() => {
    if (!focus) return;
    focusTarget.current = { gcx: focus.gx, gcy: focus.gy, scale: FOCUS_SCALE };
  }, [focus?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track the Space key so a left-drag pans (instead of paints) while it's held.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spacePressed.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spacePressed.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

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

  // Raster one cell into its chunk's buffer + RGBA image (O(1)), grow the painted-
  // content bbox, and mark the chunk dirty for the next frame's re-blit. Shared by
  // the authoritative `syncPaints` (co-signed paints folded in by seq) and the
  // optimistic in-stroke echo (`placeAt`), so both write pixels identically.
  const writeCell = (gx: number, gy: number, color: number) => {
    const cx = chunkOf(gx);
    const cy = chunkOf(gy);
    const key = `${cx},${cy}`;
    const chunk = ensureChunk(key);
    if (!chunk) return;
    const bb = bbox.current;
    if (!bb) {
      bbox.current = { minX: gx, minY: gy, maxX: gx, maxY: gy };
    } else {
      if (gx < bb.minX) bb.minX = gx;
      if (gy < bb.minY) bb.minY = gy;
      if (gx > bb.maxX) bb.maxX = gx;
      if (gy > bb.maxY) bb.maxY = gy;
    }
    const idx = (gy - cy * CHUNK_SIZE) * CHUNK_SIZE + (gx - cx * CHUNK_SIZE);
    chunk.buf[idx] = color + 1;
    const [r, g, b] = PALETTE_RGB[color] ?? [255, 255, 255];
    const o = idx * 4;
    chunk.img.data[o] = r;
    chunk.img.data[o + 1] = g;
    chunk.img.data[o + 2] = b;
    chunk.img.data[o + 3] = 255;
    dirty.current.add(key);
  };

  // Fold every paint with a never-seen co-signed seq into the render store. Gated on
  // `revision` so the map is scanned at most once per change, not once per frame.
  // Optimistic in-stroke writes have usually already rastered these exact pixels;
  // re-folding them here is idempotent and reconciles any overpaint by another seat.
  const syncPaints = () => {
    if (syncedRevision.current === revisionRef.current) return;
    syncedRevision.current = revisionRef.current;
    let maxSeq = appliedSeq.current;
    for (const cell of paintsRef.current.values()) {
      if (cell.seq <= appliedSeq.current) continue;
      if (cell.seq > maxSeq) maxSeq = cell.seq;
      writeCell(
        Number(cell.cx) * CHUNK_SIZE + cell.x,
        Number(cell.cy) * CHUNK_SIZE + cell.y,
        cell.color,
      );
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
      // Crisp pixels: no bilinear smoothing on tile blits. Cheapest path and the
      // clean, modern look — painted cells stay sharp squares at every zoom.
      ctx.imageSmoothingEnabled = false;

      // Ease the camera toward an active jump target (set when an agent spawns).
      // Manual pan/zoom clears the target so a jump never fights the user.
      if (focusTarget.current) {
        const ft = focusTarget.current;
        const k = 0.16;
        v.scale += (ft.scale - v.scale) * k;
        const offX = cw / 2 - ft.gcx * v.scale;
        const offY = ch / 2 - ft.gcy * v.scale;
        v.offsetX += (offX - v.offsetX) * k;
        v.offsetY += (offY - v.offsetY) * k;
        if (
          Math.abs(ft.scale - v.scale) < 0.04 &&
          Math.abs(offX - v.offsetX) < 0.5 &&
          Math.abs(offY - v.offsetY) < 0.5
        ) {
          v.scale = ft.scale;
          v.offsetX = cw / 2 - ft.gcx * v.scale;
          v.offsetY = ch / 2 - ft.gcy * v.scale;
          focusTarget.current = null;
        }
      }

      // Re-rasterize tiles dirtied since the last frame (bound by paints/frame).
      for (const key of dirty.current) {
        const c = chunks.current.get(key);
        if (c) c.ctx.putImageData(c.img, 0, 0);
      }
      dirty.current.clear();

      // Backdrop: the whole viewport is the empty canvas void; painted chunks
      // are blitted on top.
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

      // Agent markers: a small pin + label above each agent's flag, so the user
      // always sees where every bot is currently drawing. Flat — no halo gradient.
      for (const a of agentsRef.current) {
        const cxs = v.offsetX + a.gx * v.scale;
        const topYs = v.offsetY + (a.gy - a.h / 2) * v.scale;
        if (cxs < -160 || cxs > cw + 160 || topYs < -40 || topYs > ch + 80) {
          continue;
        }
        drawAgentMarker(ctx, cxs, topYs, a.label, a.flagName, a.tint);
      }

      // Brush footprint preview: a thin outline of the N×N block the next paint
      // lays down, in the active color. One cheap stroked rect — no soft dab.
      const hc = hover.current;
      if (hc && !disabled && !panOnlyRef.current) {
        const n = brushSizeRef.current;
        const off = Math.floor(n / 2);
        const sx = v.offsetX + (hc.gx - off) * v.scale;
        const sy = v.offsetY + (hc.gy - off) * v.scale;
        const side = n * v.scale;
        ctx.fillStyle = PALETTE[selColorRef.current] ?? "#ffffff";
        ctx.globalAlpha = 0.22;
        ctx.fillRect(sx, sy, side, side);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = WC.accent;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx + 0.5, sy + 0.5, side - 1, side - 1);
      }

      const now = performance.now();
      if (now - lastHud > 80) {
        lastHud = now;
        setHud((prev) => {
          const cell = hover.current;
          // Resolve the owner of the hovered cell for the floating "owner …" label.
          let owner: { label: string; sx: number; sy: number } | null = null;
          if (cell) {
            const ccx = chunkOf(cell.gx);
            const ccy = chunkOf(cell.gy);
            const p = paintsRef.current.get(
              cellKey(
                BigInt(ccx),
                BigInt(ccy),
                cell.gx - ccx * CHUNK_SIZE,
                cell.gy - ccy * CHUNK_SIZE,
              ),
            );
            if (p) {
              owner = {
                label:
                  p.painter === humanRef.current
                    ? "You"
                    : `owner ${shortAddress(p.painter)}`,
                sx: v.offsetX + (cell.gx + 0.5) * v.scale,
                sy: v.offsetY + cell.gy * v.scale,
              };
            }
          }
          if (
            prev.zoom === v.scale &&
            prev.cell?.gx === cell?.gx &&
            prev.cell?.gy === cell?.gy &&
            prev.owner?.label === owner?.label &&
            prev.owner?.sx === owner?.sx &&
            prev.owner?.sy === owner?.sy
          )
            return prev;
          return { zoom: v.scale, cell, owner };
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [disabled]);

  // A pointer gesture is EITHER a paint stroke (left-drag) or a pan (right/space/
  // hand-tool drag). `last` is the previous painted cell, the anchor the next sample
  // interpolates from so the stroke stays gap-free.
  const drag = useRef<{
    lastX: number;
    lastY: number;
    moved: number;
    panning: boolean;
    painting: boolean;
    last: GlobalCell | null;
  } | null>(null);

  const localXY = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };

  // Paint ONE cell of the active stroke: dedupe against the stroke set, echo it into
  // the local raster INSTANTLY (optimistic — no waiting on the co-sign), then fire
  // the co-sign without awaiting. The tunnel is off-chain, so `onPaint` co-signs
  // near-instantly; we still never block the pointer loop on it. One newly-painted
  // cell = one co-signed move.
  const placeAt = (cell: GlobalCell) => {
    if (disabled) return;
    const key = `${cell.gx},${cell.gy}`;
    if (strokeSet.current.has(key)) return; // already co-signed this stroke
    strokeSet.current.add(key);
    const color = selColorRef.current;
    writeCell(cell.gx, cell.gy, color); // instant optimistic echo
    const cx = chunkOf(cell.gx);
    const cy = chunkOf(cell.gy);
    onPaint(
      BigInt(cx),
      BigInt(cy),
      cell.gx - cx * CHUNK_SIZE,
      cell.gy - cy * CHUNK_SIZE,
      color,
    );
  };

  // Stamp the brush footprint (an N×N block) centered on a cell. Each cell is an
  // independent dedup'd co-signed move, so a bigger brush is just more cells/TPS.
  const stampBrush = (center: GlobalCell) => {
    const n = brushSizeRef.current;
    const off = Math.floor(n / 2);
    for (let dy = 0; dy < n; dy++) {
      for (let dx = 0; dx < n; dx++) {
        placeAt({ gx: center.gx - off + dx, gy: center.gy - off + dy });
      }
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    focusTarget.current = null; // user takes the wheel; cancel any active jump
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const { sx, sy } = localXY(e);
    const cell = cellAt(sx, sy);
    hover.current = cell;
    // Left button with no Space/hand modifier draws; right/middle button, held
    // Space, or the hand tool pans. A disabled wall never paints, but may pan.
    const wantsPan = e.button !== 0 || spacePressed.current || panOnlyRef.current;
    const painting = !wantsPan && !disabled;
    drag.current = {
      lastX: sx,
      lastY: sy,
      moved: 0,
      panning: wantsPan,
      painting,
      last: painting ? cell : null,
    };
    if (painting) {
      strokeSet.current.clear(); // start a fresh stroke
      stampBrush(cell); // a plain click already paints its cell
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const { sx, sy } = localXY(e);
    const cell = cellAt(sx, sy);
    hover.current = cell;
    const d = drag.current;
    if (!d) return;
    const dx = sx - d.lastX;
    const dy = sy - d.lastY;
    d.moved += Math.abs(dx) + Math.abs(dy);

    if (d.painting) {
      // Continuous stroke: rasterize the line from the last painted cell to this one
      // (samples can be many cells apart on a fast drag), stamping the brush at each
      // step. Per-cell dedupe keeps every cell to exactly one co-signed move.
      const from = d.last ?? cell;
      for (const c of interpolateCells(from.gx, from.gy, cell.gx, cell.gy)) {
        stampBrush(c);
      }
      d.last = cell;
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
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.painting) strokeSet.current.clear(); // end the stroke
  };
  const onPointerLeave = () => {
    hover.current = null;
    if (drag.current?.painting) strokeSet.current.clear();
    drag.current = null;
  };

  const zoomBy = (factor: number, sx?: number, sy?: number) => {
    focusTarget.current = null; // manual zoom always wins over an active jump
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

  // ⊙ "fit to content": frame every painted cell (with a little padding) so a
  // reset always lands on the art, never a blank region. Recenters the empty
  // origin only when nothing has been painted yet. Cancels any active camera jump.
  const resetView = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    focusTarget.current = null;
    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    const v = view.current;
    const bb = bbox.current;
    if (!bb) {
      v.scale = 10;
      v.offsetX = cw / 2;
      v.offsetY = ch / 2;
      return;
    }
    const pad = 2; // cells of breathing room around the content
    const gW = bb.maxX - bb.minX + 1 + pad * 2;
    const gH = bb.maxY - bb.minY + 1 + pad * 2;
    const scale = Math.max(
      ZOOM.min,
      Math.min(ZOOM.max, Math.min(cw / gW, ch / gH)),
    );
    const cgx = (bb.minX + bb.maxX + 1) / 2;
    const cgy = (bb.minY + bb.maxY + 1) / 2;
    v.scale = scale;
    v.offsetX = cw / 2 - cgx * scale;
    v.offsetY = ch / 2 - cgy * scale;
  };
  const onWheel = (e: React.WheelEvent) => {
    focusTarget.current = null; // manual zoom cancels any active jump
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
        onContextMenu={(e) => e.preventDefault()}
        onWheel={onWheel}
        style={{
          touchAction: "none",
          cursor: disabled || panOnly ? "grab" : "crosshair",
        }}
      />
      {/* Floating per-cell owner label ("owner EThL…KwRE" / "You"). */}
      {hud.owner && (
        <div
          style={{
            position: "absolute",
            left: hud.owner.sx,
            top: hud.owner.sy,
            transform: "translate(-50%, calc(-100% - 8px))",
            pointerEvents: "none",
            padding: "3px 8px",
            borderRadius: 8,
            fontSize: 10.5,
            fontWeight: 700,
            whiteSpace: "nowrap",
            color: WC.text,
            fontFamily: FONT_MONO,
            background: "rgba(10,16,34,0.92)",
            border: `1px solid ${WC.panelBorder}`,
            boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
            zIndex: 5,
          }}
        >
          {hud.owner.label}
        </div>
      )}
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
        <ZoomButton label="⊙" onClick={resetView} />
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

/** Trace a rounded-rectangle path (no fill/stroke) for marker label pills. */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw an agent's marker: a tinted pin on the flag's top edge and a label pill
 * ("Agent #n · Vietnam") floating just above it, so it's always clear which bot
 * owns which flag and where it's painting.
 */
function drawAgentMarker(
  ctx: CanvasRenderingContext2D,
  cxs: number,
  topYs: number,
  label: string,
  flagName: string,
  tint: string,
): void {
  const text = `${label} · ${flagName}`;
  ctx.save();
  ctx.font = `700 11px ${FONT_DISPLAY}`;
  ctx.textBaseline = "middle";
  const padX = 8;
  const dotGap = 9;
  const tw = ctx.measureText(text).width;
  const boxW = tw + padX * 2 + dotGap;
  const boxH = 18;
  const boxX = cxs - boxW / 2;
  const boxY = topYs - boxH - 9;

  // Connector stem from the pill down to a pin on the flag's top edge.
  ctx.strokeStyle = tint;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cxs, boxY + boxH);
  ctx.lineTo(cxs, topYs - 1);
  ctx.stroke();
  ctx.fillStyle = tint;
  ctx.beginPath();
  ctx.arc(cxs, topYs - 1, 2.6, 0, Math.PI * 2);
  ctx.fill();

  // Label pill.
  roundRectPath(ctx, boxX, boxY, boxW, boxH, 6);
  ctx.fillStyle = "rgba(10,16,34,0.92)";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = tint;
  ctx.stroke();

  // Tint dot + label text.
  ctx.fillStyle = tint;
  ctx.beginPath();
  ctx.arc(boxX + padX, boxY + boxH / 2, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8e8f0";
  ctx.fillText(text, boxX + padX + dotGap, boxY + boxH / 2 + 0.5);
  ctx.restore();
}
