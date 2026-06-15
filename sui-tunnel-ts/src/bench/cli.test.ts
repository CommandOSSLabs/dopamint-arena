import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "./cli";

// These validate that bad input is rejected up front (before any benchmark runs), instead
// of becoming NaN and silently producing a garbage/zero run.

test("REPRO #11: a non-numeric --agents value is rejected (not silently NaN)", async () => {
  await assert.rejects(() => main(["--agents", "foo"]), /finite number/);
});

test("an invalid --sign-mode value is rejected", async () => {
  await assert.rejects(
    () => main(["--sign-mode", "bogus"]),
    /full\|sign-only\|none/,
  );
});
