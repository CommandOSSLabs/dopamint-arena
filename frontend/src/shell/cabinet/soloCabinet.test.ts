import { test } from "node:test";
import assert from "node:assert/strict";
import { isSoloOfferable, soloCabinetController } from "./soloCabinet";

test("take-over is offerable only in solo mode, playing, on auto", () => {
  assert.equal(isSoloOfferable("solo", "playing", true), true);
  assert.equal(isSoloOfferable("solo", "playing", false), false); // already took over
  assert.equal(isSoloOfferable("pvp", "playing", true), false);
  assert.equal(isSoloOfferable(null, "playing", true), false);
  assert.equal(isSoloOfferable("solo", "funding", true), false);
  assert.equal(isSoloOfferable("solo", "settled", true), false);
});

test("controller.active mirrors offerable", () => {
  const verbs = { pause() {}, resume() {}, toggleAuto() {}, goHome() {} };
  assert.equal(
    soloCabinetController({ offerable: true, auto: true, ...verbs }).active,
    true,
  );
  assert.equal(
    soloCabinetController({ offerable: false, auto: true, ...verbs }).active,
    false,
  );
});

test("takeOver flips auto off then unfreezes, in that order", () => {
  const calls: string[] = [];
  const c = soloCabinetController({
    offerable: true,
    auto: true,
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    toggleAuto: () => calls.push("toggleAuto"),
    goHome: () => calls.push("home"),
  });
  c.takeOver();
  assert.deepEqual(calls, ["toggleAuto", "resume"]);
});

test("takeOver does NOT re-toggle when already manual — only resumes", () => {
  const calls: string[] = [];
  const c = soloCabinetController({
    offerable: false,
    auto: false,
    pause() {},
    resume: () => calls.push("resume"),
    toggleAuto: () => calls.push("toggleAuto"),
    goHome() {},
  });
  c.takeOver();
  assert.deepEqual(calls, ["resume"]);
});

test("returnHome delegates to goHome", () => {
  let homed = false;
  const c = soloCabinetController({
    offerable: true,
    auto: true,
    pause() {},
    resume() {},
    toggleAuto() {},
    goHome: () => {
      homed = true;
    },
  });
  c.returnHome();
  assert.equal(homed, true);
});
