import { test } from "node:test";
import assert from "node:assert/strict";
import { capSeries, downsample } from "./useTpsHistory";

test("capSeries keeps the newest points within the window length", () => {
  const pts = Array.from({ length: 5 }, (_, i) => ({ t: i, v: i }));
  assert.deepEqual(capSeries(pts, 3), [
    { t: 2, v: 2 },
    { t: 3, v: 3 },
    { t: 4, v: 4 },
  ]);
});

test("downsample keeps each bucket's peak so spikes survive decimation", () => {
  // 10 points → target 5 → buckets of 2; the higher value (and its timestamp) wins each bucket.
  const pts = [
    { t: 0, v: 1 },
    { t: 1, v: 9 },
    { t: 2, v: 2 },
    { t: 3, v: 3 },
    { t: 4, v: 8 },
    { t: 5, v: 4 },
    { t: 6, v: 5 },
    { t: 7, v: 6 },
    { t: 8, v: 7 },
    { t: 9, v: 0 },
  ];
  assert.deepEqual(downsample(pts, 5), [
    { t: 1, v: 9 },
    { t: 3, v: 3 },
    { t: 4, v: 8 },
    { t: 7, v: 6 },
    { t: 8, v: 7 },
  ]);
});

test("downsample returns the input untouched when already within budget", () => {
  const pts = [
    { t: 0, v: 1 },
    { t: 1, v: 2 },
  ];
  assert.equal(downsample(pts, 5), pts);
});
