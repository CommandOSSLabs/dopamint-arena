import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMpUrl } from "./main.ts";

test("buildMpUrl converts http to ws", () => {
  assert.equal(
    buildMpUrl("http://localhost:8080"),
    "ws://localhost:8080/v1/mp",
  );
});

test("buildMpUrl preserves https to wss", () => {
  assert.equal(
    buildMpUrl("https://api.example.com/"),
    "wss://api.example.com/v1/mp",
  );
});
