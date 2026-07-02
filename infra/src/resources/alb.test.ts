import { describe, it } from "node:test";
import assert from "node:assert";
import * as pulumi from "@pulumi/pulumi";
import { createAlb } from "./alb.js";

async function awaitOutput<T>(output: pulumi.Output<T>): Promise<T> {
  return (output as unknown as { promise(): Promise<T> }).promise();
}

describe("backend ALB", () => {
  // Session affinity: the resume `resync` must reach the co-located bot, which lives on one instance.
  // App-cookie stickiness on the `aff` cookie (set by the WS handshake) pins a browser's reconnect to
  // that instance, keeping resume in-process instead of relying on best-effort cross-instance pub/sub.
  it("enables app-cookie stickiness on `aff`", async () => {
    const { targetGroup } = createAlb("test", {
      vpcId: "vpc-1",
      subnetIds: ["subnet-1", "subnet-2"],
      securityGroupId: "sg-1",
    });
    const stickiness = await awaitOutput(targetGroup.stickiness);
    assert.ok(stickiness, "stickiness must be configured");
    assert.strictEqual(stickiness.enabled, true);
    assert.strictEqual(stickiness.type, "app_cookie");
    assert.strictEqual(
      stickiness.cookieName,
      "aff",
      "must key off the WS handshake's affinity cookie",
    );
    assert.ok(
      stickiness.cookieDuration && stickiness.cookieDuration > 0,
      "app_cookie stickiness requires a positive duration",
    );
  });
});
