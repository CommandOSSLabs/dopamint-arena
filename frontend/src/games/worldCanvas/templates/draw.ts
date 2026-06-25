/**
 * Canvas2D renderers for stamp templates, shared by the picker thumbnails (StampDock
 * + agent template strip) and the on-canvas armed ghost in WorldCanvas. Both draw the
 * SAME vector paths — so a new registry entry gets a free thumbnail and a free ghost
 * with zero extra wiring. These are pure render helpers; they never co-sign anything.
 */
import { PALETTE } from "../ui/tokens";
import type { StrokeTemplate } from "./types";

/** Draw a template's paths with unit (0,0) at screen `(ox, oy)`, `unitPx` px per unit. */
function drawPaths(
  ctx: CanvasRenderingContext2D,
  tpl: StrokeTemplate,
  ox: number,
  oy: number,
  unitPx: number,
): void {
  for (const path of tpl.paths) {
    const hex = PALETTE[path.color] ?? "#ffffff";
    if (path.kind === "fill") {
      ctx.beginPath();
      for (const ring of path.rings) {
        if (ring.length === 0) continue;
        ctx.moveTo(ox + ring[0].x * unitPx, oy + ring[0].y * unitPx);
        for (let i = 1; i < ring.length; i++) {
          ctx.lineTo(ox + ring[i].x * unitPx, oy + ring[i].y * unitPx);
        }
        ctx.closePath();
      }
      ctx.fillStyle = hex;
      ctx.fill("evenodd");
    } else {
      const pts = path.points;
      if (pts.length === 0) continue;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(1, path.radius * 2 * unitPx);
      ctx.strokeStyle = hex;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(
          ox + pts[0].x * unitPx,
          oy + pts[0].y * unitPx,
          ctx.lineWidth / 2,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = hex;
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(ox + pts[0].x * unitPx, oy + pts[0].y * unitPx);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(ox + pts[i].x * unitPx, oy + pts[i].y * unitPx);
      }
      if (path.closed) ctx.closePath();
      ctx.stroke();
    }
  }
}

/** Render a template centered + fit into a `size`×`size` thumbnail (with padding). */
export function drawTemplateThumb(
  ctx: CanvasRenderingContext2D,
  tpl: StrokeTemplate,
  size: number,
): void {
  ctx.clearRect(0, 0, size, size);
  const pad = size * 0.14;
  const inner = size - pad * 2;
  const unitPx = inner / Math.max(tpl.aspect.w, tpl.aspect.h);
  const ox = pad + (inner - tpl.aspect.w * unitPx) / 2;
  const oy = pad + (inner - tpl.aspect.h * unitPx) / 2;
  ctx.save();
  drawPaths(ctx, tpl, ox, oy, unitPx);
  ctx.restore();
}

/** Overlay the armed template as a translucent ghost on the world canvas. `ox,oy` is
 *  the screen position of the stamp's top-left; `unitPx` px per template unit. */
export function drawTemplateGhost(
  ctx: CanvasRenderingContext2D,
  tpl: StrokeTemplate,
  ox: number,
  oy: number,
  unitPx: number,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  drawPaths(ctx, tpl, ox, oy, unitPx);
  ctx.restore();
}
