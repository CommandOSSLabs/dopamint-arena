import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface EcsOutputs {
  clusterName: pulumi.Output<string>;
  clusterArn: pulumi.Output<string>;
  logGroupName: pulumi.Output<string>;
}

export function createEcs(name: string): EcsOutputs {
  const cluster = new aws.ecs.Cluster(`${name}-cluster`, {
    settings: [{ name: "containerInsights", value: "enabled" }],
  });

  const logGroup = new aws.cloudwatch.LogGroup(`${name}-backend-logs`, {
    retentionInDays: 7,
  });

  return { clusterName: cluster.name, clusterArn: cluster.arn, logGroupName: logGroup.name };
}
