import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";

test("loadConfig reads required vars", () => {
  process.env.BACKEND_URL = "http://localhost:8080";
  process.env.TUNNEL_PACKAGE_ID = "0xabc";
  process.env.DOPAMINT_PACKAGE_ID = "0xdef";
  process.env.DOPAMINT_FAUCET_ID = "0x123";
  process.env.DOPAMINT_COIN_TYPE = "0xdef::dopamint::DOPAMINT";
  process.env.OPERATOR_KEY = "enoki...";
  const cfg = loadConfig();
  assert.equal(cfg.backendUrl, "http://localhost:8080");
  assert.equal(cfg.stakeRaw, 1_000_000_000n);
});
