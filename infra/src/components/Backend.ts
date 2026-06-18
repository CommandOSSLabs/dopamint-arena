import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BackendOutputs {
  taskDefinition: aws.ecs.TaskDefinition;
  taskDefinitionArn: pulumi.Output<string>;
  migrationTaskDefinition: aws.ecs.TaskDefinition;
  migrationTaskDefinitionArn: pulumi.Output<string>;
}

export interface BackendArgs {
  name: string;
  repositoryUrl: pulumi.Input<string>;
  imageTag: pulumi.Input<string>;
  pubSubEndpoint: pulumi.Input<string>;
  cacheEndpoint: pulumi.Input<string>;
  taskExecutionRoleArn: pulumi.Input<string>;
  taskRoleArn: pulumi.Input<string>;
  logGroupName: pulumi.Input<string>;
  // Secrets Manager ARN holding the base64 ed25519 settler key, injected as
  // SUI_SETTLER_KEY via ECS `secrets`. Omitted => the env var is simply absent.
  settlerKeySecretArn?: pulumi.Input<string>;
  cpu?: pulumi.Input<string>;
  memory?: pulumi.Input<string>;
}

function makeContainerDefinitions(args: BackendArgs): pulumi.Output<string> {
  return pulumi
    .all([
      args.repositoryUrl,
      args.imageTag,
      args.pubSubEndpoint,
      args.cacheEndpoint,
      args.logGroupName,
      args.settlerKeySecretArn ?? pulumi.output(undefined),
    ])
    .apply(
      ([
        repositoryUrl,
        imageTag,
        pubSubEndpoint,
        cacheEndpoint,
        logGroupName,
        settlerKeySecretArn,
      ]) =>
        JSON.stringify([
          {
            name: "backend",
            image: `${repositoryUrl}:${imageTag}`,
            essential: true,
            portMappings: [{ containerPort: 8080, protocol: "tcp" }],
            environment: [
              { name: "REDIS_PUBSUB_URL", value: `rediss://${pubSubEndpoint}:6379` },
              { name: "REDIS_CACHE_URL", value: `rediss://${cacheEndpoint}:6379` },
              { name: "SUI_RPC_URL", value: "https://fullnode.testnet.sui.io:443" },
              { name: "TUNNEL_PACKAGE_ID", value: "0x0000000000000000000000000000000000000000000000000000000000000001" },
              { name: "WALRUS_PUBLISHER_URL", value: "https://publisher.walrus-testnet.walrus.space" },
              { name: "WALRUS_AGGREGATOR_URL", value: "https://aggregator.walrus-testnet.walrus.space" },
            ],
            // Private key: injected from Secrets Manager, never inlined as plaintext env.
            ...(settlerKeySecretArn
              ? { secrets: [{ name: "SUI_SETTLER_KEY", valueFrom: settlerKeySecretArn }] }
              : {}),
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": logGroupName,
                "awslogs-region": aws.config.region ?? "us-east-1",
                "awslogs-stream-prefix": "backend",
              },
            },
            healthCheck: {
              command: ["CMD-SHELL", "curl -f http://localhost:8080/health/live || exit 1"],
              interval: 30,
              timeout: 5,
              retries: 3,
              startPeriod: 60,
            },
            stopTimeout: 30,
          },
        ])
    );
}

function makeMigrationContainerDefinitions(args: BackendArgs): pulumi.Output<string> {
  return pulumi
    .all([args.repositoryUrl, args.imageTag, args.logGroupName])
    .apply(([repositoryUrl, imageTag, logGroupName]) =>
      JSON.stringify([
        {
          name: "migrate",
          image: `${repositoryUrl}:${imageTag}`,
          essential: true,
          command: ["sh", "-c", "echo 'no migration required'"],
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroupName,
              "awslogs-region": aws.config.region ?? "us-east-1",
              "awslogs-stream-prefix": "migrate",
            },
          },
        },
      ])
    );
}

export function createBackend(args: BackendArgs): BackendOutputs {
  const name = args.name;
  const containerDefinitions = makeContainerDefinitions(args);
  const migrationContainerDefinitions = makeMigrationContainerDefinitions(args);

  const taskDefinition = new aws.ecs.TaskDefinition(`${name}-backend-td`, {
    family: `${name}-backend`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: args.cpu ?? "1024",
    memory: args.memory ?? "2048",
    runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
    executionRoleArn: args.taskExecutionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions,
  });

  const migrationTaskDefinition = new aws.ecs.TaskDefinition(`${name}-backend-migrate-td`, {
    family: `${name}-backend-migrate`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "1024",
    memory: "2048",
    runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
    executionRoleArn: args.taskExecutionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions: migrationContainerDefinitions,
  });

  return {
    taskDefinition,
    taskDefinitionArn: taskDefinition.arn,
    migrationTaskDefinition,
    migrationTaskDefinitionArn: migrationTaskDefinition.arn,
  };
}
