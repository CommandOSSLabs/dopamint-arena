import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface CacheOutputs {
  pubSubEndpoint: pulumi.Output<string>;
  cacheEndpoint: pulumi.Output<string>;
}

export function createCache(
  name: string,
  args: {
    subnetIds: pulumi.Input<string[]>;
    securityGroupId: pulumi.Input<string>;
    nodeType: string;
  }
): CacheOutputs {
  const subnetGroup = new aws.elasticache.SubnetGroup(`${name}-cache-subnets`, {
    subnetIds: args.subnetIds,
  });

  const pubSubCluster = new aws.elasticache.ReplicationGroup(`${name}-pubsub-cmd`, {
    description: "Pub/Sub Redis for TPS stream",
    engine: "redis",
    engineVersion: "7.1",
    nodeType: args.nodeType,
    numCacheClusters: 2,
    automaticFailoverEnabled: true,
    subnetGroupName: subnetGroup.name,
    securityGroupIds: [args.securityGroupId],
    atRestEncryptionEnabled: true,
    transitEncryptionEnabled: true,
  });

  const cacheCluster = new aws.elasticache.ReplicationGroup(`${name}-cache-cmd`, {
    description: "Cache Redis for sessions and counters",
    engine: "redis",
    engineVersion: "7.1",
    nodeType: args.nodeType,
    numCacheClusters: 2,
    automaticFailoverEnabled: true,
    subnetGroupName: subnetGroup.name,
    securityGroupIds: [args.securityGroupId],
    atRestEncryptionEnabled: true,
    transitEncryptionEnabled: true,
  });

  return {
    pubSubEndpoint: pubSubCluster.primaryEndpointAddress,
    cacheEndpoint: cacheCluster.primaryEndpointAddress,
  };
}
