import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface ExplorerServicesArgs {
  name: string;
  clusterId: pulumi.Input<string>;
  clusterName: pulumi.Input<string>;
  repositoryUrl: pulumi.Input<string>;
  imageTag: pulumi.Input<string>;
  logGroupName: pulumi.Input<string>;
  taskExecutionRoleArn: pulumi.Input<string>;
  taskRoleArn: pulumi.Input<string>;
  subnetIds: pulumi.Input<string[]>;
  securityGroupId: pulumi.Input<string>; // reuse the backend SG (allowed to DB + Redis)
  databaseUrlSecretArn: pulumi.Input<string>;
  pubSubEndpoint: pulumi.Input<string>;
  // ALB plumbing for the api (the indexer has no inbound).
  vpcId: pulumi.Input<string>;
  listener: aws.lb.Listener;
}

export interface ExplorerServicesOutputs {
  indexerServiceName: pulumi.Output<string>;
  apiServiceName: pulumi.Output<string>;
  apiTargetGroupArn: pulumi.Output<string>;
}

function logConfig(logGroupName: pulumi.Input<string>, prefix: string) {
  return {
    logDriver: "awslogs",
    options: {
      "awslogs-group": logGroupName,
      "awslogs-region": aws.config.region ?? "us-east-1",
      "awslogs-stream-prefix": prefix,
    },
  };
}

export function createExplorerServices(args: ExplorerServicesArgs): ExplorerServicesOutputs {
  const n = args.name;

  // --- indexer (single writer, no inbound) ---
  const indexerDefs = pulumi
    .all([args.repositoryUrl, args.imageTag, args.pubSubEndpoint, args.logGroupName, args.databaseUrlSecretArn])
    .apply(([repo, tag, pubsub, logGroup, dbUrlArn]) =>
      JSON.stringify([
        {
          name: "indexer",
          image: `${repo}:${tag}`,
          essential: true,
          // Framework IngestionClientArgs has a required(true) clap arg-group; the binary
          // exits immediately without a checkpoint source. This is the testnet remote store.
          // `--first-checkpoint` starts ingestion near tip so the indexer reaches recent
          // settlements in minutes instead of backfilling from genesis (testnet is at ~351.69M).
          // It captures the existing on-chain settlements (~351.653M) and then tracks live. Only
          // takes effect against a fresh pipeline watermark (see handler.rs SettlementPipeline).
          command: [
            "/usr/local/bin/indexer",
            "--remote-store-url",
            "https://checkpoints.testnet.sui.io",
            "--first-checkpoint",
            "351650000",
          ],
          environment: [
            { name: "TUNNEL_PACKAGE_ID", value: "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b" },
            { name: "REDIS_PUBSUB_URL", value: `rediss://${pubsub}:6379` },
            // Framework subscriber honors RUST_LOG; without it the indexer is silent (no
            // ingestion progress, no errors) — see the 11h dark-running incident.
            { name: "RUST_LOG", value: "info" },
          ],
          secrets: [{ name: "DATABASE_URL", valueFrom: dbUrlArn }],
          logConfiguration: logConfig(logGroup, "indexer"),
          stopTimeout: 30,
        },
      ])
    );

  const indexerTd = new aws.ecs.TaskDefinition(`${n}-indexer-td`, {
    family: `${n}-indexer`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "512",
    memory: "1024",
    runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
    executionRoleArn: args.taskExecutionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions: indexerDefs,
  });

  // SINGLETON: desiredCount 1, max 100% so a deploy stops the old before starting new —
  // never two writers concurrently.
  const indexerService = new aws.ecs.Service(`${n}-indexer-service`, {
    cluster: args.clusterId,
    taskDefinition: indexerTd.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    deploymentMaximumPercent: 100,
    deploymentMinimumHealthyPercent: 0,
    networkConfiguration: {
      assignPublicIp: false,
      subnets: args.subnetIds,
      securityGroups: [args.securityGroupId],
    },
  });

  // --- explorer-api (read-only, autoscaled, behind the ALB) ---
  const apiTg = new aws.lb.TargetGroup(`${n}-explorer-tg`, {
    port: 8080,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: args.vpcId,
    healthCheck: {
      path: "/health/ready",
      port: "8080",
      protocol: "HTTP",
      healthyThreshold: 2,
      unhealthyThreshold: 3,
      interval: 30,
      timeout: 5,
    },
  });

  // Route the explorer paths to the api; everything else stays on the default (control) TG.
  // Priority 10 — no existing listener rules on this ALB.
  new aws.lb.ListenerRule(`${n}-explorer-rule`, {
    listenerArn: args.listener.arn,
    priority: 10,
    actions: [{ type: "forward", targetGroupArn: apiTg.arn }],
    conditions: [
      { pathPattern: { values: ["/v1/settlements", "/v1/settlements/*", "/v1/explorer/*", "/v1/stats/explorer"] } },
    ],
  });

  const apiDefs = pulumi
    .all([args.repositoryUrl, args.imageTag, args.pubSubEndpoint, args.logGroupName, args.databaseUrlSecretArn])
    .apply(([repo, tag, pubsub, logGroup, dbUrlArn]) =>
      JSON.stringify([
        {
          name: "api",
          image: `${repo}:${tag}`,
          essential: true,
          command: ["/usr/local/bin/api"],
          portMappings: [{ containerPort: 8080, protocol: "tcp" }],
          environment: [
            { name: "WALRUS_AGGREGATOR_URL", value: "https://aggregator.walrus-testnet.walrus.space" },
            { name: "REDIS_PUBSUB_URL", value: `rediss://${pubsub}:6379` },
          ],
          secrets: [{ name: "DATABASE_URL", valueFrom: dbUrlArn }],
          logConfiguration: logConfig(logGroup, "explorer-api"),
          healthCheck: {
            command: ["CMD-SHELL", "curl -f http://localhost:8080/health/ready || exit 1"],
            interval: 30,
            timeout: 5,
            retries: 3,
            startPeriod: 30,
          },
          stopTimeout: 30,
        },
      ])
    );

  const apiTd = new aws.ecs.TaskDefinition(`${n}-explorer-api-td`, {
    family: `${n}-explorer-api`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "512",
    memory: "1024",
    runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
    executionRoleArn: args.taskExecutionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions: apiDefs,
  });

  const apiService = new aws.ecs.Service(
    `${n}-explorer-api-service`,
    {
      cluster: args.clusterId,
      taskDefinition: apiTd.arn,
      desiredCount: 2,
      launchType: "FARGATE",
      deploymentMaximumPercent: 200,
      deploymentMinimumHealthyPercent: 100,
      healthCheckGracePeriodSeconds: 30,
      networkConfiguration: {
        assignPublicIp: false,
        subnets: args.subnetIds,
        securityGroups: [args.securityGroupId],
      },
      loadBalancers: [{ targetGroupArn: apiTg.arn, containerName: "api", containerPort: 8080 }],
    },
    { dependsOn: [args.listener] }
  );

  // Autoscale the api on CPU (readers scale with CCU, independent of the control plane).
  const scaleTarget = new aws.appautoscaling.Target(`${n}-explorer-api-scale`, {
    maxCapacity: 6,
    minCapacity: 1,
    resourceId: pulumi.interpolate`service/${args.clusterName}/${apiService.name}`,
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
  });
  new aws.appautoscaling.Policy(`${n}-explorer-api-cpu`, {
    policyType: "TargetTrackingScaling",
    resourceId: scaleTarget.resourceId,
    scalableDimension: scaleTarget.scalableDimension,
    serviceNamespace: scaleTarget.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
      targetValue: 60,
      predefinedMetricSpecification: { predefinedMetricType: "ECSServiceAverageCPUUtilization" },
      scaleInCooldown: 120,
      scaleOutCooldown: 60,
    },
  });

  return {
    indexerServiceName: indexerService.name,
    apiServiceName: apiService.name,
    apiTargetGroupArn: apiTg.arn,
  };
}
