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
 * The draw cursor: a pencil tip (the FloatingToolbar's PencilIcon path) as an inline
 * SVG data-URI, so painting feels like sketching — the arena's drawing affordance,
 * matching the other games' tool cursors. A dark halo keeps it visible on light ink;
 * the hotspot sits on the pencil's nib (bottom-left). Falls back to `crosshair`.
 */
const PENCIL_CURSOR =
  `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="%23000" stroke-opacity="0.5" stroke-width="3.6"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></g><g stroke="%23fff" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></g></svg>') 2 20, crosshair`;

/**
 * The infinite vector-ink wall — a single HTML5 canvas with pan (drag),
 * zoom-to-cursor (wheel), and drag-to-paint. The co-signed unit is still one CELL
 * (one cell = one tunnel move = 1 TPS, unchanged), but the VISUAL is real ink: each
 * painter's contiguous run of cells is grouped into a STROKE and rendered as a
 * smooth, anti-aliased native canvas line (round caps + joins) — not a grid of
 * squares. So the art reads like a brush, not pixels.
 *
 * Strokes are built incrementally from the parent's ordered `paints` stream: each
 * agent's cells append to that agent's open stroke (a big positional jump starts a
 * new one); the human's own strokes come straight from the live pointer path for a
 * crisp, lag-free preview, finalized on pointer-up. Finalized strokes cache their
 * world-space points + bbox and are projected + stroked per frame, culled to the
 * viewport — so cost is bound by what's on screen.
 */

/** A positional jump larger than this (in cells) ends a painter's stroke and starts
 *  a new one — so an agent hopping to a fresh region doesn't draw a seam across the wall. */
const STROKE_GAP_CELLS = 4;
/** Stroke width (cells) for agent art; the human's width tracks the brush-size selector. */
const AGENT_STROKE_SIZE = 1.7;
/** Cap on retained finalized strokes — constant memory for an endless wall (oldest evicted). */
const MAX_STROKES = 12_000;

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

/** A finalized stroke: its world-space cell-center points (the polyline) + width + bbox + tint. */
interface Stroke {
  color: number;
  /** Cell-center points of the painter's run; stroked as a round-capped path per frame. */
  pts: number[][];
  /** Line width in cells (projected by the camera scale at draw time). */
  size: number;
  /** Eraser stroke — rendered in the live backdrop color so it covers ("erases"). */
  erase: boolean;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
/** A stroke still being extended (an agent's current run, or the human's live drag). */
interface OpenStroke {
  color: number;
  size: number;
  erase: boolean;
  pts: number[][];
  lastX: number;
  lastY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
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
  background,
  erasing,
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
  /** Latest camera-jump request; the view eases to center this point on change. An
   *  optional `scale` overrides the default focus zoom — PvP's participant chips ease to a
   *  wider, comfortable level so the painter's area is visible; solo omits it and keeps
   *  {@link FOCUS_SCALE} (so its existing view behavior is unchanged). */
  focus: (CanvasFocus & { scale?: number }) | null;
  /** The human's address, so a hovered cell the human painted reads "You". */
  humanAddress: string;
  /** Canvas backdrop color (Excalidraw-style); the eraser paints this to "erase". */
  background: string;
  /** True when the eraser tool is active — the human's stroke renders in `background`. */
  erasing: boolean;
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

  // Render store: finalized strokes (cached outlines) + each painter's open stroke,
  // built from the co-signed paint stream; plus the highest seq already folded in.
  const strokes = useRef<Stroke[]>([]);
  const openStrokes = useRef<Map<string, OpenStroke>>(new Map());
  // The human's live drag, captured from the raw pointer path for a crisp preview.
  const liveStroke = useRef<OpenStroke | null>(null);
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
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  const erasingRef = useRef(erasing);
  erasingRef.current = erasing;
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
    focusTarget.current = {
      gcx: focus.gx,
      gcy: focus.gy,
      scale: focus.scale ?? FOCUS_SCALE,
    };
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

  // Grow the painted-content bbox (global cells) for the ⊙ fit-to-content reset.
  const growBbox = (gx: number, gy: number) => {
    const bb = bbox.current;
    if (!bb) {
      bbox.current = { minX: gx, minY: gy, maxX: gx, maxY: gy };
    } else {
      if (gx < bb.minX) bb.minX = gx;
      if (gy < bb.minY) bb.minY = gy;
      if (gx > bb.maxX) bb.maxX = gx;
      if (gy > bb.maxY) bb.maxY = gy;
    }
  };

  // Freeze an open stroke into a cached polyline + width + bbox; evict the oldest
  // when the retained set is full (constant memory for an endless wall).
  const finalizeStroke = (s: OpenStroke) => {
    if (!s.pts.length) return;
    strokes.current.push({
      color: s.color,
      pts: s.pts,
      size: s.size,
      erase: s.erase,
      minX: s.minX,
      minY: s.minY,
      maxX: s.maxX,
      maxY: s.maxY,
    });
    if (strokes.current.length > MAX_STROKES) strokes.current.shift();
  };

  // Append a cell's world-center point to its painter's open stroke; a big jump (new
  // region / pen lift) finalizes the current one and starts a fresh stroke.
  const extendStroke = (key: string, px: number, py: number, color: number, size: number) => {
    growBbox(Math.floor(px), Math.floor(py));
    const open = openStrokes.current.get(key);
    if (
      open &&
      open.color === color &&
      Math.hypot(px - open.lastX, py - open.lastY) <= STROKE_GAP_CELLS
    ) {
      open.pts.push([px, py]);
      open.lastX = px;
      open.lastY = py;
      open.minX = Math.min(open.minX, px);
      open.minY = Math.min(open.minY, py);
      open.maxX = Math.max(open.maxX, px);
      open.maxY = Math.max(open.maxY, py);
      return;
    }
    if (open) finalizeStroke(open);
    openStrokes.current.set(key, {
      color,
      size,
      erase: false, // agents never erase
      pts: [[px, py]],
      lastX: px,
      lastY: py,
      minX: px,
      minY: py,
      maxX: px,
      maxY: py,
    });
  };

  // Fold every paint with a never-seen co-signed seq into the stroke store. Gated on
  // `revision` so the map is scanned at most once per change, not once per frame. The
  // HUMAN's own cells are skipped here — the human stroke comes from the live pointer
  // path (crisper) and is finalized on pointer-up; agents build from their cell runs.
  const syncPaints = () => {
    if (syncedRevision.current === revisionRef.current) return;
    syncedRevision.current = revisionRef.current;
    let maxSeq = appliedSeq.current;
    const human = humanRef.current;
    for (const cell of paintsRef.current.values()) {
      if (cell.seq <= appliedSeq.current) continue;
      if (cell.seq > maxSeq) maxSeq = cell.seq;
      const gx = Number(cell.cx) * CHUNK_SIZE + cell.x;
      const gy = Number(cell.cy) * CHUNK_SIZE + cell.y;
      if (cell.painter === human) {
        growBbox(gx, gy);
        continue;
      }
      extendStroke(cell.painter, gx + 0.5, gy + 0.5, cell.color, AGENT_STROKE_SIZE);
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
      // Anti-aliased vector ink (smooth stroke fills, round joins/caps).
      ctx.imageSmoothingEnabled = true;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

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

      // Backdrop: the chosen canvas color; ink strokes paint on top.
      const bg = backgroundRef.current;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cw, ch);

      // Visible world-cell bounds (with slack) for stroke culling.
      const gMinX = -v.offsetX / v.scale;
      const gMinY = -v.offsetY / v.scale;
      const gMaxX = (cw - v.offsetX) / v.scale;
      const gMaxY = (ch - v.offsetY) / v.scale;
      const pad = 6;
      const visible = (s: {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
      }) =>
        s.maxX >= gMinX - pad &&
        s.minX <= gMaxX + pad &&
        s.maxY >= gMinY - pad &&
        s.minY <= gMaxY + pad;

      // Stroke one world-space polyline at the current pan/zoom with a round-capped
      // line (smooth, anti-aliased — no taper). Eraser strokes paint the backdrop
      // color so they cover earlier ink (a visual erase on append-only art). A lone
      // point (a single click) draws as a round dab so a tap still leaves a mark.
      const strokePath = (
        pts: number[][],
        color: number,
        size: number,
        erase: boolean,
      ) => {
        if (!pts.length) return;
        const ink = erase ? bg : (PALETTE[color] ?? "#ffffff");
        const lw = Math.max(1, size * v.scale);
        if (pts.length === 1) {
          ctx.fillStyle = ink;
          ctx.beginPath();
          ctx.arc(
            v.offsetX + pts[0][0] * v.scale,
            v.offsetY + pts[0][1] * v.scale,
            lw / 2,
            0,
            Math.PI * 2,
          );
          ctx.fill();
          return;
        }
        ctx.beginPath();
        ctx.moveTo(
          v.offsetX + pts[0][0] * v.scale,
          v.offsetY + pts[0][1] * v.scale,
        );
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(
            v.offsetX + pts[i][0] * v.scale,
            v.offsetY + pts[i][1] * v.scale,
          );
        }
        ctx.lineWidth = lw;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = ink;
        ctx.stroke();
      };

      // Finalized strokes (cached polylines) → agents' open strokes → the human's
      // live drag, all culled to the viewport.
      for (const s of strokes.current) {
        if (visible(s)) strokePath(s.pts, s.color, s.size, s.erase);
      }
      for (const s of openStrokes.current.values()) {
        if (visible(s)) strokePath(s.pts, s.color, s.size, s.erase);
      }
      const live = liveStroke.current;
      if (live && live.pts.length) {
        strokePath(live.pts, live.color, live.size, live.erase);
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

  // The human's live drag is captured as a smooth pointer path (fractional world
  // cells) for a crisp, lag-free ink preview; it's finalized into the stroke store
  // on pointer-up. Width tracks the brush-size selector.
  const worldAt = (sx: number, sy: number) => {
    const v = view.current;
    return { wx: (sx - v.offsetX) / v.scale, wy: (sy - v.offsetY) / v.scale };
  };
  const liveBegin = (sx: number, sy: number) => {
    const { wx, wy } = worldAt(sx, sy);
    liveStroke.current = {
      color: selColorRef.current,
      // The eraser is a fatter nib and renders in the backdrop color (covers = erases).
      size: brushSizeRef.current * (erasingRef.current ? 3 : 1.6),
      erase: erasingRef.current,
      pts: [[wx, wy]],
      lastX: wx,
      lastY: wy,
      minX: wx,
      minY: wy,
      maxX: wx,
      maxY: wy,
    };
  };
  const livePush = (sx: number, sy: number) => {
    const s = liveStroke.current;
    if (!s) return;
    const { wx, wy } = worldAt(sx, sy);
    s.pts.push([wx, wy]);
    s.minX = Math.min(s.minX, wx);
    s.minY = Math.min(s.minY, wy);
    s.maxX = Math.max(s.maxX, wx);
    s.maxY = Math.max(s.maxY, wy);
  };
  const liveFinalize = () => {
    if (liveStroke.current) {
      finalizeStroke(liveStroke.current);
      liveStroke.current = null;
    }
  };

  // Co-sign ONE cell of the active stroke (the TPS unit): dedupe against the stroke
  // set, then fire the co-sign without awaiting. The on-canvas ink comes from the
  // live pointer path above, not from this cell. One new cell = one co-signed move.
  const placeAt = (cell: GlobalCell) => {
    if (disabled) return;
    const key = `${cell.gx},${cell.gy}`;
    if (strokeSet.current.has(key)) return; // already co-signed this stroke
    strokeSet.current.add(key);
    const color = selColorRef.current;
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
      liveBegin(sx, sy); // begin the smooth ink preview
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
      livePush(sx, sy); // extend the smooth ink preview along the cursor path
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
    if (d?.painting) {
      strokeSet.current.clear(); // end the stroke
      liveFinalize(); // freeze the ink preview into the stroke store
    }
  };
  const onPointerLeave = () => {
    hover.current = null;
    if (drag.current?.painting) {
      strokeSet.current.clear();
      liveFinalize();
    }
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
          cursor: disabled || panOnly ? "grab" : PENCIL_CURSOR,
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
      {/* Zoom HUD (bottom-left) — capped to the canvas width and wrap-friendly so it never
          runs off-screen in a narrow window. */}
      <div
        className="absolute bottom-[18px] left-4 flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-[12px]"
        style={{
          maxWidth: "calc(100% - 32px)",
          background: WC.glass,
          border: `1px solid ${WC.glassBorder}`,
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
