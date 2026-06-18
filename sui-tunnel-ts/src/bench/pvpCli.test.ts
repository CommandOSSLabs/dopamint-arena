import { test } from "node:test";
import assert from "node:assert";
import { parseArgs } from "./pvpCli";

test("pvpCli parses defaults", () => {
  const cfg = parseArgs(["node", "cli"]);
  assert.strictEqual(cfg.pairs, 1);
  assert.strictEqual(cfg.durationMs, 10000);
  assert.strictEqual(cfg.backendUrl, "ws://localhost:8080/v1/mp");
});

test("pvpCli parses --key=value overrides", () => {
  const cfg = parseArgs([
    "node",
    "cli",
    "--pairs=4",
    "--duration=5000",
    "--backendUrl=ws://x",
  ]);
  assert.strictEqual(cfg.pairs, 4);
  assert.strictEqual(cfg.durationMs, 5000);
  assert.strictEqual(cfg.backendUrl, "ws://x");
});

test("pvpCli parses --key value overrides", () => {
  const cfg = parseArgs([
    "node",
    "cli",
    "--pairs",
    "8",
    "--duration",
    "3000",
    "--backendUrl",
    "ws://y",
  ]);
  assert.strictEqual(cfg.pairs, 8);
  assert.strictEqual(cfg.durationMs, 3000);
  assert.strictEqual(cfg.backendUrl, "ws://y");
});

test("pvpCli rejects invalid numeric arguments", () => {
  assert.throws(() => parseArgs(["node", "cli", "--pairs=abc"]), /Invalid/);
  assert.throws(() => parseArgs(["node", "cli", "--duration=-1"]), /Invalid/);
  assert.throws(() => parseArgs(["node", "cli", "--pairs=2.5"]), /Invalid/);
  assert.throws(() => parseArgs(["node", "cli", "--duration=3.14"]), /Invalid/);
});
