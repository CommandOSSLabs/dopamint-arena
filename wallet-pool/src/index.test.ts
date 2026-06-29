import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "./index";

test("package loads", () => {
  assert.equal(VERSION, "0.1.0");
});
