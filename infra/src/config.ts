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
  backendImageTag: string;
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
    backendImageTag: config.get("backend-image-tag") ?? "latest",
  };
}
