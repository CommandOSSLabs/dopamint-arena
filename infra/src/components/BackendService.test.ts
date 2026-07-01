import { describe, it } from "node:test";
import assert from "node:assert";
import * as pulumi from "@pulumi/pulumi";
import {
  createBackendService,
  type BackendServiceArgs,
} from "./BackendService.js";

async function awaitOutput<T>(output: pulumi.Output<T>): Promise<T> {
  return (output as unknown as { promise(): Promise<T> }).promise();
}

function makeBackendServiceArgs(
  overrides: Partial<BackendServiceArgs> = {},
): BackendServiceArgs {
  return {
    name: "test",
    clusterId: "arn:aws:ecs:us-east-1:123:cluster/test-cluster",
    clusterName: "test-cluster",
    taskDefinitionArn: "arn:aws:ecs:us-east-1:123:task-definition/test:1",
    targetGroupArn:
      "arn:aws:elasticloadbalancing:us-east-1:123:targetgroup/test/abc",
    securityGroupId: "sg-123",
    subnetIds: ["subnet-1", "subnet-2"],
    listener: undefined,
    ...overrides,
  };
}

describe("backend service component", () => {
  it("uses default scaling bounds and CPU target", async () => {
    const svc = createBackendService(makeBackendServiceArgs());

    assert.ok(
      svc.scalableTarget,
      "must create a scalable target when max > min",
    );
    assert.ok(svc.scalingPolicy, "must create a scaling policy when max > min");
    assert.strictEqual(await awaitOutput(svc.service.desiredCount), 2);
    assert.strictEqual(
      await awaitOutput(svc.scalableTarget.minCapacity),
      2,
      "min capacity must default to 2",
    );
    assert.strictEqual(
      await awaitOutput(svc.scalableTarget.maxCapacity),
      10,
      "max capacity must default to 10",
    );
    assert.strictEqual(
      await awaitOutput(svc.scalableTarget.scalableDimension),
      "ecs:service:DesiredCount",
    );
    assert.strictEqual(
      await awaitOutput(svc.scalableTarget.serviceNamespace),
      "ecs",
    );

    const resourceId = await awaitOutput(svc.scalableTarget.resourceId);
    assert.ok(
      resourceId.startsWith("service/test-cluster/"),
      `resourceId must identify the service, got ${resourceId}`,
    );

    const policyConfig = await awaitOutput(
      svc.scalingPolicy.targetTrackingScalingPolicyConfiguration,
    );
    assert.ok(policyConfig, "policy configuration must be present");
    assert.strictEqual(policyConfig?.targetValue, 70);
    assert.strictEqual(
      policyConfig?.predefinedMetricSpecification?.predefinedMetricType,
      "ECSServiceAverageCPUUtilization",
    );
  });

  it("honors custom scaling settings", async () => {
    const svc = createBackendService(
      makeBackendServiceArgs({
        desiredCount: 3,
        minCapacity: 3,
        maxCapacity: 8,
        targetCpuPercent: 60,
      }),
    );

    assert.strictEqual(await awaitOutput(svc.service.desiredCount), 3);
    assert.strictEqual(await awaitOutput(svc.scalableTarget!.minCapacity), 3);
    assert.strictEqual(await awaitOutput(svc.scalableTarget!.maxCapacity), 8);

    const policyConfig = await awaitOutput(
      svc.scalingPolicy!.targetTrackingScalingPolicyConfiguration,
    );
    assert.strictEqual(policyConfig?.targetValue, 60);
  });

  it("does not create autoscaling resources when max equals min", async () => {
    const svc = createBackendService(
      makeBackendServiceArgs({
        minCapacity: 2,
        maxCapacity: 2,
      }),
    );

    assert.strictEqual(svc.scalableTarget, undefined);
    assert.strictEqual(svc.scalingPolicy, undefined);
    assert.strictEqual(await awaitOutput(svc.service.desiredCount), 2);
  });
});
