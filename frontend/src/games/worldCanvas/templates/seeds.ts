/**
 * The seed STAMP TEMPLATE catalog — CommandOSS (logo placeholder), Vietnamese arts
 * (flag, star, lotus, Đông Hồ pig), generic shapes (heart, star), and a stroke-font
 * text mark. All are pure vector data in a unit box, colors pre-quantized to the
 * 16-index palette; adding one is a single entry in {@link TEMPLATES}.
 *
 * The geometry helpers below build the rings/polylines; nothing here touches the
 * cell grid — that happens once in `rasterizeTemplate`.
 */
import { starPolygon, type Vec2 } from "../geometry";
import { buildText } from "./font";
import type { StrokeTemplate, TemplatePath } from "./types";

// ── Palette indices (ui/tokens.ts PALETTE) ───────────────────────────────────────
const WHITE = 0;
const PINK = 4;
const RED = 5;
const ORANGE = 6;
const BROWN = 7;
const YELLOW = 8;
const LIGHT_GREEN = 9;
const GREEN = 10;
const SUI_BLUE = 13;

/** A closed regular polygon ring (sides ≥ 3), `rot` radians from the +x axis. */
function regularPolygon(
  cx: number,
  cy: number,
  r: number,
  sides: number,
  rot = 0,
): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** A closed circle approximated by `segs` points. */
function circle(cx: number, cy: number, r: number, segs = 20): Vec2[] {
  return regularPolygon(cx, cy, r, segs);
}

// ── CommandOSS — placeholder logo mark (blue badge + white "</>" code glyph) ──────
function buildCommandOss(): StrokeTemplate {
  const cx = 15;
  const cy = 15;
  const paths: TemplatePath[] = [
    // Rounded badge (octagon) in Sui blue — the brand plate.
    {
      kind: "fill",
      color: SUI_BLUE,
      rings: [regularPolygon(cx, cy, 14, 8, Math.PI / 8)],
    },
    // White "</>" open-source code glyph over the badge.
    {
      kind: "stroke",
      color: WHITE,
      radius: 1.0,
      points: [
        { x: 11, y: 9.5 },
        { x: 6.5, y: 15 },
        { x: 11, y: 20.5 },
      ],
    },
    {
      kind: "stroke",
      color: WHITE,
      radius: 1.0,
      points: [
        { x: 18, y: 8.5 },
        { x: 12, y: 21.5 },
      ],
    },
    {
      kind: "stroke",
      color: WHITE,
      radius: 1.0,
      points: [
        { x: 19, y: 9.5 },
        { x: 23.5, y: 15 },
        { x: 19, y: 20.5 },
      ],
    },
  ];
  return {
    id: "commandoss",
    name: "CommandOSS",
    category: "logo",
    aspect: { w: 30, h: 30 },
    paths,
  };
}

// ── Vietnam flag — red field, gold star (deliberate field→star overpaint) ─────────
function buildVnFlag(): StrokeTemplate {
  const w = 30;
  const h = 20;
  return {
    id: "vn-flag",
    name: "VN Flag",
    category: "vietnam",
    aspect: { w, h },
    dedupe: false, // keep the field cell AND the star cell as two co-signed moves
    paths: [
      {
        kind: "fill",
        color: RED,
        rings: [
          [
            { x: 0, y: 0 },
            { x: w, y: 0 },
            { x: w, y: h },
            { x: 0, y: h },
          ],
        ],
      },
      {
        kind: "fill",
        color: YELLOW,
        rings: [starPolygon(w / 2, h / 2, 8.4, 3.5)],
      },
    ],
  };
}

// ── Vietnam gold star (standalone) ────────────────────────────────────────────────
function buildVnStar(): StrokeTemplate {
  return {
    id: "vn-star",
    name: "Gold Star",
    category: "vietnam",
    aspect: { w: 20, h: 20 },
    paths: [
      { kind: "fill", color: YELLOW, rings: [starPolygon(10, 10, 9, 3.75)] },
    ],
  };
}

// ── Lotus — layered pink petals, gold center, green stem ──────────────────────────
function lotusPetal(
  cx: number,
  cy: number,
  len: number,
  halfW: number,
  angle: number,
): Vec2[] {
  const ring: Vec2[] = [];
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const place = (along: number, side: number) => {
    const lx = along * len;
    const ly = side;
    ring.push({ x: cx + lx * ca - ly * sa, y: cy + lx * sa + ly * ca });
  };
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    place(s, halfW * Math.sin(Math.PI * s));
  }
  for (let i = steps; i >= 0; i--) {
    const s = i / steps;
    place(s, -halfW * Math.sin(Math.PI * s));
  }
  return ring;
}

function buildLotus(): StrokeTemplate {
  const cx = 15;
  const cy = 13;
  const paths: TemplatePath[] = [];
  // Stem first (drawn under the bloom).
  paths.push({
    kind: "stroke",
    color: GREEN,
    radius: 0.8,
    points: [
      { x: 15, y: 25 },
      { x: 14.5, y: 29 },
      { x: 15, y: 33 },
    ],
  });
  paths.push({
    kind: "fill",
    color: LIGHT_GREEN,
    rings: [lotusPetal(13, 28, 6, 2, Math.PI * 0.92)],
  });
  paths.push({
    kind: "fill",
    color: LIGHT_GREEN,
    rings: [lotusPetal(17, 30, 6, 2, Math.PI * 0.08)],
  });
  // Outer ring of 8 petals, then an inner offset ring of 8 — a layered bloom.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 - Math.PI / 2;
    paths.push({
      kind: "fill",
      color: PINK,
      rings: [lotusPetal(cx, cy, 11, 3.1, a)],
    });
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 - Math.PI / 2 + Math.PI / 8;
    paths.push({
      kind: "fill",
      color: RED,
      rings: [lotusPetal(cx, cy, 7.5, 2.3, a)],
    });
  }
  paths.push({ kind: "fill", color: YELLOW, rings: [circle(cx, cy, 2.6, 14)] });
  return {
    id: "lotus",
    name: "Lotus",
    category: "vietnam",
    aspect: { w: 30, h: 34 },
    paths,
  };
}

// ── Đông Hồ pig — brown line-art with the signature flank spiral ───────────────────
function spiralPoints(
  cx: number,
  cy: number,
  turns: number,
  maxR: number,
  step = 0.3,
): Vec2[] {
  const pts: Vec2[] = [];
  const maxT = turns * Math.PI * 2;
  const a = maxR / maxT;
  for (let t = 0; t <= maxT; t += step) {
    pts.push({ x: cx + a * t * Math.cos(t), y: cy + a * t * Math.sin(t) });
  }
  return pts;
}

function buildDongHo(): StrokeTemplate {
  const ink = BROWN;
  const paths: TemplatePath[] = [
    // Body (closed oval blob).
    {
      kind: "stroke",
      color: ink,
      radius: 0.85,
      closed: true,
      points: ovalRing(19, 13, 15, 8),
    },
    // Ear.
    {
      kind: "stroke",
      color: ink,
      radius: 0.7,
      closed: true,
      points: [
        { x: 7, y: 7 },
        { x: 10, y: 2.5 },
        { x: 12.5, y: 7.5 },
      ],
    },
    // Snout (small ring at the front).
    {
      kind: "stroke",
      color: ink,
      radius: 0.7,
      closed: true,
      points: circle(4.2, 13.5, 2.2, 12),
    },
    // Eye (a filled dab).
    { kind: "stroke", color: ink, radius: 1.0, points: [{ x: 9.5, y: 10.5 }] },
    // Four legs.
    {
      kind: "stroke",
      color: ink,
      radius: 0.7,
      points: [
        { x: 9, y: 19.5 },
        { x: 8.5, y: 26 },
      ],
    },
    {
      kind: "stroke",
      color: ink,
      radius: 0.7,
      points: [
        { x: 15, y: 20.5 },
        { x: 15, y: 27 },
      ],
    },
    {
      kind: "stroke",
      color: ink,
      radius: 0.7,
      points: [
        { x: 24, y: 20.5 },
        { x: 24.5, y: 27 },
      ],
    },
    {
      kind: "stroke",
      color: ink,
      radius: 0.7,
      points: [
        { x: 30, y: 19.5 },
        { x: 31, y: 26 },
      ],
    },
    // Curly tail at the back.
    {
      kind: "stroke",
      color: ink,
      radius: 0.6,
      points: [
        { x: 34, y: 11 },
        { x: 37, y: 9 },
        { x: 37, y: 13 },
        { x: 34.5, y: 13 },
      ],
    },
    // The iconic âm-dương flank spiral.
    {
      kind: "stroke",
      color: ink,
      radius: 0.6,
      points: spiralPoints(22, 13, 1.6, 5.5),
    },
  ];
  return {
    id: "dong-ho",
    name: "Đông Hồ Pig",
    category: "vietnam",
    aspect: { w: 38, h: 28 },
    paths,
  };
}

/** A closed ellipse ring (used for the pig body). */
function ovalRing(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  segs = 22,
): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return pts;
}

// ── Heart — filled red region from a parametric heart curve ────────────────────────
function buildHeart(): StrokeTemplate {
  const raw: Vec2[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = (i / 64) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y =
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      Math.cos(4 * t);
    raw.push({ x, y: -y }); // flip: screen y grows downward
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of raw) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = 1;
  const ring = raw.map((p) => ({ x: p.x - minX + pad, y: p.y - minY + pad }));
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  return {
    id: "heart",
    name: "Heart",
    category: "shape",
    aspect: { w, h },
    paths: [{ kind: "fill", color: RED, rings: [ring] }],
  };
}

// ── Star — gold fill with an orange outline ────────────────────────────────────────
function buildStar(): StrokeTemplate {
  return {
    id: "star",
    name: "Star",
    category: "shape",
    aspect: { w: 22, h: 22 },
    paths: [
      { kind: "fill", color: YELLOW, rings: [starPolygon(11, 11, 9.5, 3.9)] },
      {
        kind: "stroke",
        color: ORANGE,
        radius: 0.6,
        closed: true,
        points: starPolygon(11, 11, 10.2, 4.2),
      },
    ],
  };
}

/**
 * The stamp-template registry — every surface (human Stamp dock + agent template
 * strip) renders `TEMPLATES` directly, so a new template appears in both with a free
 * vector thumbnail. Order here is the render order within each category.
 */
export const TEMPLATES: readonly StrokeTemplate[] = [
  buildCommandOss(),
  buildVnFlag(),
  buildVnStar(),
  buildLotus(),
  buildDongHo(),
  buildHeart(),
  buildStar(),
  buildText("GM SUI", SUI_BLUE),
];

/** Lookup by id (picker selection → template). */
export const TEMPLATES_BY_ID: Record<string, StrokeTemplate> =
  Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));

/** Category render order for the grouped pickers. */
export const TEMPLATE_CATEGORIES = [
  "logo",
  "vietnam",
  "shape",
  "text",
] as const;

/** Human-readable caption per category. */
export const TEMPLATE_CATEGORY_LABELS: Record<string, string> = {
  logo: "Logo",
  vietnam: "Vietnam",
  shape: "Shapes",
  text: "Text",
};
