import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bottom,
  collides,
  compact,
  fitToColumns,
  type GridItem,
  moveItem,
  nextPosition,
  resizeItem,
  resolveCollisions,
} from "./grid-layout-engine";

const item = (over: Partial<GridItem> & { id: string }): GridItem => ({
  x: 0,
  y: 0,
  w: 2,
  h: 2,
  ...over,
});

test("collides is true only when rectangles overlap, never with self", () => {
  const a = item({ id: "a", x: 0, y: 0, w: 2, h: 2 });
  assert.equal(collides(a, a), false);
  assert.equal(collides(a, item({ id: "b", x: 1, y: 1, w: 2, h: 2 })), true);
  assert.equal(collides(a, item({ id: "c", x: 2, y: 0, w: 2, h: 2 })), false); // touching edge
  assert.equal(collides(a, item({ id: "d", x: 0, y: 2, w: 2, h: 2 })), false); // stacked
});

test("bottom returns the first empty row below every item", () => {
  assert.equal(
    bottom([item({ id: "a", y: 0, h: 3 }), item({ id: "b", y: 1, h: 5 })]),
    6,
  );
  assert.equal(bottom([]), 0);
});

test("compact floats items up to fill vertical gaps", () => {
  const layout = [
    item({ id: "a", x: 0, y: 5, w: 3, h: 2 }),
    item({ id: "b", x: 0, y: 9, w: 3, h: 2 }),
  ];
  const out = compact(layout);
  assert.equal(out.find((i) => i.id === "a")!.y, 0);
  assert.equal(out.find((i) => i.id === "b")!.y, 2); // stacked directly under a
});

test("compact stacks items that share columns instead of overlapping", () => {
  const out = compact([
    item({ id: "a", x: 0, y: 3, w: 4, h: 2 }),
    item({ id: "b", x: 0, y: 8, w: 4, h: 2 }),
  ]);
  const a = out.find((i) => i.id === "a")!;
  const b = out.find((i) => i.id === "b")!;
  assert.equal(collides(a, b), false);
});

test("compact leaves items in different columns at row 0 side by side", () => {
  const out = compact([
    item({ id: "a", x: 0, y: 4, w: 3, h: 2 }),
    item({ id: "b", x: 6, y: 9, w: 3, h: 2 }),
  ]);
  assert.equal(out.find((i) => i.id === "a")!.y, 0);
  assert.equal(out.find((i) => i.id === "b")!.y, 0);
});

test("compact preserves input array order for stable React keys", () => {
  const out = compact([
    item({ id: "a", x: 0, y: 5 }),
    item({ id: "b", x: 6, y: 1 }),
    item({ id: "c", x: 3, y: 9 }),
  ]);
  assert.deepEqual(
    out.map((i) => i.id),
    ["a", "b", "c"],
  );
});

test("compact keeps static items pinned", () => {
  const out = compact([item({ id: "pinned", x: 0, y: 4, static: true })]);
  assert.equal(out[0].y, 4);
});

test("resolveCollisions cascades a stack downward", () => {
  const layout = [
    item({ id: "moved", x: 0, y: 0, w: 4, h: 2 }),
    item({ id: "a", x: 0, y: 1, w: 4, h: 2 }),
    item({ id: "b", x: 0, y: 3, w: 4, h: 2 }),
  ];
  resolveCollisions(layout, layout[0]);
  assert.equal(layout.find((i) => i.id === "a")!.y, 2); // pushed below moved
  assert.equal(layout.find((i) => i.id === "b")!.y, 4); // pushed below a (cascade)
});

test("moveItem clamps x within the grid and pushes collisions down", () => {
  const layout = [
    item({ id: "a", x: 0, y: 0, w: 3, h: 2 }),
    item({ id: "b", x: 5, y: 0, w: 3, h: 2 }),
  ];
  // try to move b far past the right edge (cols = 12, w = 3 -> max x = 9)
  const out = moveItem(layout, "b", 99, 0, 12);
  assert.equal(out.find((i) => i.id === "b")!.x, 9);
});

test("moveItem onto another item shoves it down", () => {
  const layout = [
    item({ id: "a", x: 0, y: 0, w: 4, h: 2 }),
    item({ id: "b", x: 0, y: 5, w: 4, h: 2 }),
  ];
  const out = moveItem(layout, "b", 0, 0, 12); // drop b onto a
  assert.equal(out.find((i) => i.id === "a")!.y, 2); // a pushed below b
  assert.equal(out.find((i) => i.id === "b")!.y, 0);
});

test("resizeItem respects minW/minH and the grid's right edge", () => {
  const layout = [item({ id: "a", x: 8, y: 0, w: 2, h: 2, minW: 2, minH: 2 })];
  const tooSmall = resizeItem(layout, "a", 0, 0, 12);
  assert.equal(tooSmall[0].w, 2); // clamped up to minW
  assert.equal(tooSmall[0].h, 2); // clamped up to minH
  const tooWide = resizeItem(layout, "a", 99, 3, 12);
  assert.equal(tooWide[0].w, 4); // cols(12) - x(8) = 4
});

test("nextPosition drops a new item at column 0 below the stack", () => {
  const pos = nextPosition([item({ id: "a", y: 0, h: 3 })]);
  assert.deepEqual(pos, { x: 0, y: 3 });
});

test("fitToColumns shrinks wide items and pulls overflow back in", () => {
  const out = fitToColumns(
    [
      item({ id: "a", x: 0, y: 0, w: 8, h: 2 }), // wider than 4 cols
      item({ id: "b", x: 9, y: 0, w: 3, h: 2 }), // starts past 4 cols
    ],
    4,
  );
  const a = out.find((i) => i.id === "a")!;
  const b = out.find((i) => i.id === "b")!;
  assert.equal(a.w, 4); // clamped to grid width
  assert.ok(b.x + b.w <= 4); // pulled inside the grid
  assert.equal(collides(a, b), false); // compacted apart
});
