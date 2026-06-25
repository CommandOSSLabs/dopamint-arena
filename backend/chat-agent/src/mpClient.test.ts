import { test } from "node:test";
import assert from "node:assert/strict";
import { MpClient } from "./mpClient.ts";

test("MpClient stores url and wallet", () => {
  const c = new MpClient("ws://localhost:8080/v1/mp", "0xABC");
  assert.equal(c["url"], "ws://localhost:8080/v1/mp");
  assert.equal(c["wallet"], "0xABC");
});
