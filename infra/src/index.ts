import * as pulumi from "@pulumi/pulumi";
import { getConfig } from "./config.js";
import { createNetwork } from "./components/Network.js";
import { createDns } from "./components/Dns.js";
import { createSecurityGroups } from "./resources/security-groups.js";
import { createAlb } from "./resources/alb.js";
import { createIam } from "./resources/iam.js";
import { createEcr } from "./resources/ecr.js";
import { createEcs } from "./resources/ecs.js";
import { createFrontend } from "./components/Frontend.js";
import { createDatabase } from "./components/Database.js";
import { createDatabaseProxy } from "./components/DatabaseProxy.js";
import { createCache } from "./components/Cache.js";
import { createBackend } from "./components/Backend.js";
import { createBackendService } from "./components/BackendService.js";
import { createBackendAlias } from "./components/BackendAlias.js";
import { createMonitoring } from "./components/Monitoring.js";
import { githubEnvOutputs } from "./github.js";

const cfg = getConfig();
const network = createNetwork(`dopamint-${cfg.environment}`);
const sgs = createSecurityGroups(`dopamint-${cfg.environment}`, network.vpcId);

const dns = createDns(`dopamint-${cfg.environment}`, {
  domain: cfg.domain,
  route53ZoneId: cfg.route53ZoneId,
});

const alb = createAlb(`dopamint-${cfg.environment}`, {
  vpcId: network.vpcId,
  subnetIds: network.publicSubnetIds,
  securityGroupId: sgs.alb.id,
  certificateArn: dns.certificateArn,
});

const frontend = createFrontend(`dopamint-${cfg.environment}`, {
  domain: cfg.domain,
  certificateArn: dns.certificateArn,
  zoneId: dns.zoneId,
});

const database = createDatabase(`dopamint-${cfg.environment}`, {
  subnetIds: network.privateSubnetIds,
  securityGroupId: sgs.db.id,
  instanceClass: cfg.dbInstanceClass,
  serverless: cfg.dbServerless,
  minCapacity: cfg.dbMinCapacity,
  maxCapacity: cfg.dbMaxCapacity,
});

const iam = createIam(`dopamint-${cfg.environment}`, {
  githubOrg: "CommandOSSLabs",
  githubRepo: "dopamint-arena",
  dbSecretArn: database.dbPasswordSecretArn,
});

const ecr = createEcr(`dopamint-${cfg.environment}`);
const ecs = createEcs(`dopamint-${cfg.environment}`);

const dbProxy = createDatabaseProxy(`dopamint-${cfg.environment}`, {
  subnetIds: network.privateSubnetIds,
  securityGroupId: sgs.db.id,
  dbClusterIdentifier: database.clusterIdentifier,
  secretArn: database.dbSecretArn,
});

const cache = createCache(`dopamint-${cfg.environment}`, {
  subnetIds: network.privateSubnetIds,
  securityGroupId: sgs.cache.id,
  nodeType: cfg.cacheNodeType,
});

const backend = createBackend({
  name: `dopamint-${cfg.environment}`,
  repositoryUrl: ecr.repositoryUrl,
  imageTag: cfg.backendImageTag,
  dbProxyEndpoint: dbProxy.proxyEndpoint,
  dbSecretArn: database.dbPasswordSecretArn,
  pubSubEndpoint: cache.pubSubEndpoint,
  cacheEndpoint: cache.cacheEndpoint,
  taskExecutionRoleArn: iam.taskExecutionRole.arn,
  taskRoleArn: iam.taskRole.arn,
  logGroupName: ecs.logGroupName,
});

const backendService = createBackendService({
  name: `dopamint-${cfg.environment}`,
  clusterId: ecs.clusterArn,
  taskDefinitionArn: backend.taskDefinitionArn,
  targetGroupArn: alb.targetGroup.arn,
  securityGroupId: sgs.backend.id,
  subnetIds: network.privateSubnetIds,
  listener: alb.httpsListener,
});

createBackendAlias({
  name: `dopamint-${cfg.environment}`,
  domain: cfg.domain,
  zoneId: dns.zoneId,
  albDnsName: alb.alb.dnsName,
  albHostedZoneId: alb.alb.zoneId,
});

createMonitoring({
  name: `dopamint-${cfg.environment}`,
  albArnSuffix: alb.alb.arnSuffix,
  targetGroupArnSuffix: alb.targetGroup.arnSuffix,
  clusterName: ecs.clusterName,
  serviceName: backendService.serviceName,
  dbClusterIdentifier: database.clusterIdentifier,
  logGroupName: ecs.logGroupName,
});

export const vpcId = network.vpcId;
export const privateSubnetIds = network.privateSubnetIds;
export const publicSubnetIds = network.publicSubnetIds;
export const certificateArn = dns.certificateArn;
export const albDnsName = alb.alb.dnsName;
export const albArnSuffix = alb.alb.arnSuffix;
export const githubDeployRoleArn = iam.githubDeployRoleArn;
export const frontendBucket = frontend.bucketName;
export const frontendDomain = frontend.distributionDomain;
export const cloudfrontId = frontend.distributionId;
export const dbProxyEndpoint = dbProxy.proxyEndpoint;
export const pubSubEndpoint = cache.pubSubEndpoint;
export const cacheEndpoint = cache.cacheEndpoint;
export const backendRepositoryUrl = ecr.repositoryUrl;
export const clusterName = ecs.clusterName;
export const backendLogGroup = ecs.logGroupName;
export const backendTaskDefinitionArn = backend.taskDefinitionArn;
export const migrationTaskDefinitionArn = backend.migrationTaskDefinitionArn;
export const backendServiceName = backendService.serviceName;

const backendApiDomain = pulumi.interpolate`api.${cfg.domain}`;
export const backendUrl = dns.zoneId
  ? pulumi.interpolate`https://${backendApiDomain}`
  : undefined;

export const githubEnv = dns.zoneId
  ? githubEnvOutputs({
      backendUrl: backendApiDomain,
      frontendDomain: cfg.domain,
      frontendBucket: frontend.bucketName,
      cloudfrontId: frontend.distributionId,
      ecrUrl: ecr.repositoryUrl,
      ecsCluster: ecs.clusterName,
      ecsService: backendService.serviceName,
      migrationTaskDef: backend.migrationTaskDefinitionArn,
      githubDeployRoleArn: iam.githubDeployRoleArn,
      privateSubnetIds: network.privateSubnetIds,
      backendSecurityGroupId: sgs.backend.id,
    })
  : undefined;
