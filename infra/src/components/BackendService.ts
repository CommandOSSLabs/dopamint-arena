import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BackendServiceOutputs {
  serviceName: pulumi.Output<string>;
  serviceArn: pulumi.Output<string>;
}

export interface BackendServiceArgs {
  name: string;
  clusterId: pulumi.Input<string>;
  taskDefinitionArn: pulumi.Input<string>;
  targetGroupArn: pulumi.Input<string>;
  securityGroupId: pulumi.Input<string>;
  subnetIds: pulumi.Input<string[]>;
  desiredCount?: number;
  listener?: aws.lb.Listener;
}

export function createBackendService(args: BackendServiceArgs): BackendServiceOutputs {
  // For the PvP load test, a single large task keeps relay traffic local.
  // Increase desiredCount only after profiling shows single-task limits,
  // because additional tasks split match peers across instances and increase cross-instance relay traffic.
  const desiredCount = args.desiredCount ?? 2;
  const service = new aws.ecs.Service(
    `${args.name}-backend-service`,
    {
      cluster: args.clusterId,
      taskDefinition: args.taskDefinitionArn,
      desiredCount,
      launchType: "FARGATE",
      schedulingStrategy: "REPLICA",
      deploymentMaximumPercent: 200,
      deploymentMinimumHealthyPercent: 100,
      healthCheckGracePeriodSeconds: 60,
      networkConfiguration: {
        assignPublicIp: false,
        subnets: args.subnetIds,
        securityGroups: [args.securityGroupId],
      },
      loadBalancers: [
        {
          targetGroupArn: args.targetGroupArn,
          containerName: "backend",
          containerPort: 8080,
        },
      ],
    },
    {
      dependsOn: args.listener ? [args.listener] : undefined,
    }
  );

  return { serviceName: service.name, serviceArn: service.arn };
}
