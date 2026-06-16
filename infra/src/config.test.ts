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
    });
  });

  after(() => {
    delete process.env.PULUMI_CONFIG;
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
  });

  it("applies default optional values", () => {
    const cfg = getConfig();

    assert.strictEqual(cfg.backendImageTag, "latest");
    assert.strictEqual(cfg.benchmarkImageVersion, "1.0.0");
  });
});
