/**
 * Stamp palette — the human's vector-template picker, a floating Win-98 tool window.
 * Template THUMBNAILS are drawn from each template's own vectors (a new registry
 * entry auto-appears with a free thumbnail). Arming a template makes a left-click on
 * the wall STAMP it: a bounded, chunked TPS spike instead of a brush stroke. Clicking
 * the armed template again (or Esc, handled by the parent) disarms.
 */
import { useEffect, useRef } from "react";
import {
  TEMPLATES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABELS,
  drawTemplateThumb,
  type StrokeTemplate,
} from "../templates";
import { W98, FONT_W98, w98Button } from "./tokens";
import { W98Window } from "./W98Window";

/** A template rendered into a small canvas from its own vector paths (no image asset). */
export function TemplateThumb({
  tpl,
  size,
}: {
  tpl: StrokeTemplate;
  size: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTemplateThumb(ctx, tpl, size);
  }, [tpl, size]);
  return (
    <canvas
      ref={ref}
      style={{ width: size, height: size, display: "block", pointerEvents: "none" }}
    />
  );
}

const THUMB = 38;

export function StampDock({
  armed,
  onArm,
  onClose,
}: {
  armed: StrokeTemplate | null;
  onArm: (tpl: StrokeTemplate | null) => void;
  onClose: () => void;
}) {
  return (
    <W98Window
      title="Stamps"
      icon="🏷️"
      onClose={onClose}
      storageKey="wc.stampPanel"
      defaultAnchor={{ left: 10, top: 10 }}
      width={150}
      bodyStyle={{ maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 7 }}
    >
      {TEMPLATE_CATEGORIES.map((cat) => {
        const items = TEMPLATES.filter((t) => t.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: W98.textDim }}>
              {TEMPLATE_CATEGORY_LABELS[cat]}
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {items.map((tpl) => {
                const active = armed?.id === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    onClick={() => onArm(active ? null : tpl)}
                    aria-pressed={active}
                    title={`${tpl.name} — click, then click the wall to stamp`}
                    style={{
                      ...w98Button(active),
                      padding: 2,
                      cursor: "pointer",
                      lineHeight: 0,
                    }}
                  >
                    <TemplateThumb tpl={tpl} size={THUMB} />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <span
        style={{
          fontSize: 10,
          lineHeight: 1.35,
          color: armed ? "#0a3a7a" : W98.textDim,
          fontFamily: FONT_W98,
        }}
      >
        {armed
          ? "Armed — click the wall to stamp · Esc to cancel"
          : "Pick a stamp, then click the wall."}
      </span>
    </W98Window>
  );
}
