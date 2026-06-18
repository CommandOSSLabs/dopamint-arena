import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { getConfig } from "./config.js";

describe("config optional defaults", () => {
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

  it("leaves backendDesiredCount undefined when not configured", () => {
    const cfg = getConfig();

    assert.strictEqual(cfg.backendDesiredCount, undefined);
  });
});
