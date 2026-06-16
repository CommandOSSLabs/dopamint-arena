import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BackendOutputs {
  taskDefinitionArn: pulumi.Output<string>;
  migrationTaskDefinitionArn: pulumi.Output<string>;
}

export interface BackendArgs {
  name: string;
  repositoryUrl: pulumi.Input<string>;
  imageTag: pulumi.Input<string>;
  dbProxyEndpoint: pulumi.Input<string>;
  dbSecretArn: pulumi.Input<string>;
  pubSubEndpoint: pulumi.Input<string>;
  cacheEndpoint: pulumi.Input<string>;
  taskExecutionRoleArn: pulumi.Input<string>;
  taskRoleArn: pulumi.Input<string>;
  logGroupName: pulumi.Input<string>;
}

function makeContainerDefinitions(args: BackendArgs): pulumi.Output<string> {
  return pulumi
    .all([
      args.repositoryUrl,
      args.imageTag,
      args.dbProxyEndpoint,
      args.dbSecretArn,
      args.pubSubEndpoint,
      args.cacheEndpoint,
      args.logGroupName,
    ])
    .apply(
      ([
        repositoryUrl,
        imageTag,
        dbProxyEndpoint,
        dbSecretArn,
        pubSubEndpoint,
        cacheEndpoint,
        logGroupName,
      ]) =>
        JSON.stringify([
          {
            name: "backend",
            image: `${repositoryUrl}:${imageTag}`,
            essential: true,
            portMappings: [{ containerPort: 8080, protocol: "tcp" }],
            environment: [
              { name: "DATABASE_HOST", value: dbProxyEndpoint },
              { name: "DATABASE_USER", value: "dopamint" },
              { name: "REDIS_PUB_SUB_ENDPOINT", value: pubSubEndpoint },
              { name: "REDIS_CACHE_ENDPOINT", value: cacheEndpoint },
            ],
            secrets: [{ name: "DATABASE_PASSWORD", valueFrom: dbSecretArn }],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": logGroupName,
                "awslogs-region": "us-east-1",
                "awslogs-stream-prefix": "backend",
              },
            },
            healthCheck: {
              command: ["CMD-SHELL", "curl -f http://localhost:8080/health/ready || exit 1"],
              interval: 30,
              timeout: 5,
              retries: 3,
              startPeriod: 60,
            },
          },
        ])
    );
}

export function createBackend(args: BackendArgs): BackendOutputs {
  const name = args.name;
  const containerDefinitions = makeContainerDefinitions(args);

  const taskDefinition = new aws.ecs.TaskDefinition(`${name}-backend-td`, {
    family: name,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "1024",
    memory: "2048",
    executionRoleArn: args.taskExecutionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions,
  });

  const migrationTaskDefinition = new aws.ecs.TaskDefinition(`${name}-migration-td`, {
    family: `${name}-migration`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "1024",
    memory: "2048",
    executionRoleArn: args.taskExecutionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions,
  });

  return {
    taskDefinitionArn: taskDefinition.arn,
    migrationTaskDefinitionArn: migrationTaskDefinition.arn,
  };
}
