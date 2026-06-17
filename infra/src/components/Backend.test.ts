import { describe, it } from "node:test";
import assert from "node:assert";
import * as pulumi from "@pulumi/pulumi";
import { createBackend, type BackendArgs } from "./Backend.js";

async function awaitOutput<T>(output: pulumi.Output<T>): Promise<T> {
  return (output as unknown as { promise(): Promise<T> }).promise();
}

function makeBackendArgs(overrides: Partial<BackendArgs> = {}): BackendArgs {
  return {
    name: "test",
    repositoryUrl: "123456789012.dkr.ecr.us-east-1.amazonaws.com/test",
    imageTag: "abc123",
    pubSubEndpoint: "pubsub.host",
    cacheEndpoint: "cache.host",
    taskExecutionRoleArn: "arn:aws:iam::123:role/exec",
    taskRoleArn: "arn:aws:iam::123:role/task",
    logGroupName: "/ecs/test",
    ...overrides,
  };
}

describe("backend component", () => {
  it("uses the configured image tag and exposes /health/live", async () => {
    const backend = createBackend(makeBackendArgs());

    const defs = JSON.parse(await awaitOutput(backend.taskDefinition.containerDefinitions));
    const container = defs[0];

    assert.ok(container.image.endsWith(":abc123"), "image tag must match configured SHA");
    assert.ok(
      container.healthCheck.command.some((c: string) => c.includes("/health/live")),
      "liveness probe must target /health/live",
    );
    assert.strictEqual(container.stopTimeout, 30);
    assert.ok(
      container.environment.some((e: { name: string }) => e.name === "REDIS_PUBSUB_URL"),
      "must receive REDIS_PUBSUB_URL",
    );
    assert.ok(
      container.environment.some((e: { name: string }) => e.name === "REDIS_CACHE_URL"),
      "must receive REDIS_CACHE_URL",
    );

    assert.strictEqual(await awaitOutput(backend.taskDefinition.family), "test-backend");
    assert.strictEqual(await awaitOutput(backend.taskDefinition.networkMode), "awsvpc");
    assert.deepStrictEqual(await awaitOutput(backend.taskDefinition.requiresCompatibilities), ["FARGATE"]);
    assert.strictEqual(await awaitOutput(backend.taskDefinition.cpu), "1024");
    assert.strictEqual(await awaitOutput(backend.taskDefinition.memory), "2048");
  });

  it("runs a no-op migration container", async () => {
    const backend = createBackend(makeBackendArgs());

    const defs = JSON.parse(await awaitOutput(backend.migrationTaskDefinition.containerDefinitions));
    const container = defs[0];

    assert.ok(
      container.command.some((c: string) => c.includes("no migration required")),
      "migration must be a no-op",
    );
    assert.ok(
      !container.environment?.some((e: { name: string }) => e.name === "DATABASE_URL"),
      "migration must not receive DATABASE_URL",
    );
  });
});
