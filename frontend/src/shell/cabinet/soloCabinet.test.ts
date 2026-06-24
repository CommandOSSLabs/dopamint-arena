import { test } from "node:test";
import assert from "node:assert/strict";
import { soloCabinetController } from "./soloCabinet";

test("controller.active mirrors offerable", () => {
  const verbs = { pause() {}, resume() {}, goManual() {}, goHome() {} };
  assert.equal(soloCabinetController({ offerable: true, ...verbs }).active, true);
  assert.equal(
    soloCabinetController({ offerable: false, ...verbs }).active,
    false,
  );
});

test("takeOver hands the seat to the human, then unfreezes — in that order", () => {
  const calls: string[] = [];
  const c = soloCabinetController({
    offerable: true,
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    goManual: () => calls.push("goManual"),
    goHome: () => calls.push("home"),
  });
  c.takeOver();
  assert.deepEqual(calls, ["goManual", "resume"]);
});

test("returnHome delegates to goHome", () => {
  let homed = false;
  const c = soloCabinetController({
    offerable: true,
    pause() {},
    resume() {},
    goManual() {},
    goHome: () => {
      homed = true;
    },
  });
  c.returnHome();
  assert.equal(homed, true);
});
