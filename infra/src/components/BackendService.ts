import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BackendServiceOutputs {
  service: aws.ecs.Service;
  serviceName: pulumi.Output<string>;
  serviceArn: pulumi.Output<string>;
  scalableTarget?: aws.appautoscaling.Target;
  scalingPolicy?: aws.appautoscaling.Policy;
}

export interface BackendServiceArgs {
  name: string;
  clusterId: pulumi.Input<string>;
  clusterName: pulumi.Input<string>;
  taskDefinitionArn: pulumi.Input<string>;
  targetGroupArn: pulumi.Input<string>;
  securityGroupId: pulumi.Input<string>;
  subnetIds: pulumi.Input<string[]>;
  desiredCount?: number;
  minCapacity?: number;
  maxCapacity?: number;
  targetCpuPercent?: number;
  listener?: aws.lb.Listener;
}

export function createBackendService(
  args: BackendServiceArgs,
): BackendServiceOutputs {
  const minCapacity = args.minCapacity ?? 2;
  const maxCapacity = args.maxCapacity ?? 10;
  const targetCpuPercent = args.targetCpuPercent ?? 70;
  // Start at the requested desired count, falling back to min capacity so
  // Pulumi and Application Auto Scaling agree on the floor.
  const desiredCount = args.desiredCount ?? minCapacity;

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
    },
  );

  // Register the service with Application Auto Scaling only when there is
  // actually room to scale. A max equal to min means a fixed-size service.
  let scalableTarget: aws.appautoscaling.Target | undefined;
  let scalingPolicy: aws.appautoscaling.Policy | undefined;
  if (maxCapacity > minCapacity) {
    const resourceId = pulumi.interpolate`service/${args.clusterName}/${service.name}`;

    scalableTarget = new aws.appautoscaling.Target(
      `${args.name}-backend-scale-target`,
      {
        maxCapacity,
        minCapacity,
        resourceId,
        scalableDimension: "ecs:service:DesiredCount",
        serviceNamespace: "ecs",
      },
    );

    scalingPolicy = new aws.appautoscaling.Policy(
      `${args.name}-backend-scale-cpu`,
      {
        policyType: "TargetTrackingScaling",
        resourceId,
        scalableDimension: "ecs:service:DesiredCount",
        serviceNamespace: "ecs",
        targetTrackingScalingPolicyConfiguration: {
          predefinedMetricSpecification: {
            predefinedMetricType: "ECSServiceAverageCPUUtilization",
          },
          targetValue: targetCpuPercent,
          scaleInCooldown: 300,
          scaleOutCooldown: 60,
        },
      },
    );
  }

  return {
    service,
    serviceName: service.name,
    serviceArn: service.arn,
    scalableTarget,
    scalingPolicy,
  };
}
