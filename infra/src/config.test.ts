import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { getConfig } from "./config.js";

describe("config", () => {
  before(() => {
    process.env.PULUMI_CONFIG = JSON.stringify({
      "dopamint:environment": "test",
      "dopamint:domain": "test.example",
      "dopamint:db-instance-class": "db.t3.medium",
      "dopamint:db-serverless": "false",
      "dopamint:cache-node-type": "cache.t3.micro",
      "dopamint:benchmark-instance-type": "t3.micro",
      "dopamint:benchmark-min-size": "0",
      "dopamint:benchmark-max-size": "1",
      "dopamint:backend-desired-count": "3",
      "dopamint:settler-key": "test-settler-key",
    });
    process.env.PULUMI_CONFIG_SECRET_KEYS = JSON.stringify(["dopamint:settler-key"]);
  });

  after(() => {
    delete process.env.PULUMI_CONFIG;
    delete process.env.PULUMI_CONFIG_SECRET_KEYS;
  });

  it("reads required environment config", () => {
    const cfg = getConfig();

    assert.strictEqual(cfg.environment, "test");
    assert.strictEqual(cfg.domain, "test.example");
    assert.strictEqual(cfg.dbInstanceClass, "db.t3.medium");
    assert.strictEqual(cfg.dbServerless, false);
    assert.strictEqual(cfg.cacheNodeType, "cache.t3.micro");
    assert.strictEqual(cfg.benchmarkInstanceType, "t3.micro");
    assert.strictEqual(cfg.benchmarkMinSize, 0);
    assert.strictEqual(cfg.benchmarkMaxSize, 1);
    assert.strictEqual(cfg.backendDesiredCount, 3);
  });

  it("applies default optional values", () => {
    const cfg = getConfig();

    assert.strictEqual(cfg.backendImageTag, "latest");
    assert.strictEqual(cfg.benchmarkImageVersion, "1.0.1");
  });

  // The settler key is sourced from secret config (never hardcoded), so it can be
  // wired into Secrets Manager instead of the task definition.
  it("exposes the settler key from secret config", async () => {
    const cfg = getConfig();

    assert.ok(cfg.settlerKey, "settler key must be read from secret config");
    const value = await (cfg.settlerKey as unknown as { promise(): Promise<string> }).promise();
    assert.strictEqual(value, "test-settler-key");
  });
});
