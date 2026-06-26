import { test, expect } from "bun:test";
import {
  renderAblation,
  renderAblationMarkdown,
  ablationBasename,
} from "./ablationReport";
import type { AblationResult } from "./ablation";

const fixture: AblationResult = {
  game: "blackjack",
  moves: 34,
  perMoveBudgetNs: 10000,
  buckets: [
    { label: "JSON envelope + move codec (encode+decode)", nsPerMove: 3000 },
    { label: "crypto sign+verify (native hop)", nsPerMove: 4000 },
    { label: "Promise/await wrapper (proposeAndAwait)", nsPerMove: 500 },
  ],
  attributedNs: 7500,
  residualNs: 2500,
  subMeasures: [
    { label: "of which move codec (encode+decode)", nsPerMove: 1200 },
    { label: "GC pause (aggregate)", nsPerMove: 0 },
  ],
};

test("renderAblation shows buckets, subtotal, residual, budget, percentages", () => {
  const s = renderAblation(fixture);
  expect(s).toContain("[local/offchain]");
  expect(s).toContain("JSON envelope + move codec (encode+decode)");
  expect(s).toContain("crypto sign+verify (native hop)");
  expect(s).toContain("attributed subtotal");
  expect(s).toContain("unattributed");
  expect(s).toContain("per-move budget");
  expect(s).toContain("100%"); // budget line is the 100% reference
  expect(s).toContain("30%"); // JSON 3000/10000
  expect(s).toContain("of which move codec");
});

test("renderAblation appends the rustbench floor when provided", () => {
  const s = renderAblation(fixture, 1200);
  expect(s).toContain("rustbench floor");
  expect(s).toContain("1200");
});

test("renderAblationMarkdown emits a table with a header row", () => {
  const md = renderAblationMarkdown(fixture, "20260626-120000");
  expect(md).toContain("# loadbench JS-overhead ablation");
  expect(md).toContain("| overhead | ns/move | % of budget |");
  expect(md).toContain("blackjack");
});

test("ablationBasename builds the expected filename", () => {
  expect(ablationBasename("dev", "20260626-120000")).toBe(
    "ablation-dev-20260626-120000.md",
  );
});
