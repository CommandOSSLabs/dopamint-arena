import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config("dopamint");

export interface InfraConfig {
  environment: string;
  domain: string;
  route53ZoneId?: string;
  dbInstanceClass: string;
  dbServerless: boolean;
  dbMinCapacity?: number;
  dbMaxCapacity?: number;
  cacheNodeType: string;
  benchmarkInstanceType: string;
  benchmarkMinSize: number;
  benchmarkMaxSize: number;
  benchmarkImageVersion: string;
  benchmarkPairsPerInstance?: number;
  benchmarkDurationMs?: number;
  backendImageTag: string;
  backendDesiredCount?: number;
  backendTaskCpu?: string;
  backendTaskMemory?: string;
  // base64 ed25519 settler signing key. Optional: the backend boots without it
  // (Phase 0) and fails loud at settler construction if absent. Sourced from secret
  // config so it lands in Secrets Manager, never in the task definition.
  settlerKey?: pulumi.Output<string>;
}

export function getConfig(): InfraConfig {
  return {
    environment: config.require("environment"),
    domain: config.require("domain"),
    route53ZoneId: config.get("route53-zone-id") || undefined,
    dbInstanceClass: config.require("db-instance-class"),
    dbServerless: config.requireBoolean("db-serverless"),
    dbMinCapacity: config.getNumber("db-min-capacity"),
    dbMaxCapacity: config.getNumber("db-max-capacity"),
    cacheNodeType: config.require("cache-node-type"),
    benchmarkInstanceType: config.require("benchmark-instance-type"),
    benchmarkMinSize: config.requireNumber("benchmark-min-size"),
    benchmarkMaxSize: config.requireNumber("benchmark-max-size"),
    benchmarkImageVersion: config.get("benchmark-image-version") ?? "1.0.1",
    benchmarkPairsPerInstance: config.getNumber("benchmark-pairs-per-instance") ?? undefined,
    benchmarkDurationMs: config.getNumber("benchmark-duration-ms") ?? undefined,
    backendImageTag: config.get("backend-image-tag") ?? "latest",
    backendDesiredCount: config.getNumber("backend-desired-count") ?? undefined,
    backendTaskCpu: config.get("backend-task-cpu") ?? undefined,
    backendTaskMemory: config.get("backend-task-memory") ?? undefined,
    settlerKey: config.getSecret("settler-key"),
  };
}
