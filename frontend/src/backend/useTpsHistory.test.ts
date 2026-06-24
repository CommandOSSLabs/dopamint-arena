import { test } from "node:test";
import assert from "node:assert/strict";
import { capSeries } from "./useTpsHistory";

test("capSeries keeps the newest points within the window length", () => {
  const pts = Array.from({ length: 5 }, (_, i) => ({ t: i, v: i }));
  assert.deepEqual(capSeries(pts, 3), [
    { t: 2, v: 2 },
    { t: 3, v: 3 },
    { t: 4, v: 4 },
  ]);
});
