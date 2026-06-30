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
  // Secrets Manager ARN for the internal-faucet bearer token, injected as FAUCET_ADMIN_TOKEN
  // via ECS `secrets`. Omitted => POST /v1/faucet/internal stays disabled (503).
  faucetAdminTokenSecretArn?: pulumi.Input<string>;
  // Secrets Manager ARN for the Enoki PRIVATE api key, injected as ENOKI_API_KEY via ECS
  // `secrets`. Omitted => Enoki sponsorship is off and the settler is the sole gas source.
  enokiApiKeySecretArn?: pulumi.Input<string>;
  // Secrets Manager ARN for the wallet-pool passphrase (PR #124), injected as WALLET_POOL_ACCESS_VALUE
  // via ECS `secrets`. Omitted => the pool can't open and the arena opener degrades to Noop.
  walletPoolAccessSecretArn?: pulumi.Input<string>;
  // Ollama sidecar for the chat-v2 feature. Defaults off so existing tests and
  // small environments keep the current 1024/2048 task size.
  ollamaEnabled?: pulumi.Input<boolean>;
  // Model to pull and proxy (e.g. qwen2.5:1.5b). Only used when ollamaEnabled.
  ollamaModel?: pulumi.Input<string>;
  // Tag of the ollama/ollama image to run as the sidecar.
  ollamaImageTag?: pulumi.Input<string>;
  // Comma-separated list of origins allowed by the CORS layer. Omitted => permissive CORS.
  corsAllowedOrigins?: pulumi.Input<string>;
}

function makeContainerDefinitions(args: BackendArgs): pulumi.Output<string> {
  const repositoryUrl = pulumi.output(args.repositoryUrl);
  const imageTag = pulumi.output(args.imageTag);
  const pubSubEndpoint = pulumi.output(args.pubSubEndpoint);
  const cacheEndpoint = pulumi.output(args.cacheEndpoint);
  const logGroupName = pulumi.output(args.logGroupName);
  // Bundle the three secret ARNs into one Output so the outer pulumi.all stays an 8-tuple
  // (its typed overloads stop at 8) — same reason the ollama trio is bundled below.
  const secretArns = pulumi
    .all([
      pulumi.output(args.settlerKeySecretArn ?? undefined),
      pulumi.output(args.faucetAdminTokenSecretArn ?? undefined),
      pulumi.output(args.enokiApiKeySecretArn ?? undefined),
      pulumi.output(args.walletPoolAccessSecretArn ?? undefined),
    ])
    .apply(([settler, faucetAdminToken, enoki, walletPoolAccess]) => ({
      settler,
      faucetAdminToken,
      enoki,
      walletPoolAccess,
    }));
  const corsAllowedOrigins = pulumi.output(
    args.corsAllowedOrigins ?? undefined,
  );
  const ollamaEnabled = pulumi.output(args.ollamaEnabled ?? false);
  const ollamaModel = pulumi.output(args.ollamaModel ?? "qwen2.5:1.5b");
  const ollamaImageTag = pulumi.output(args.ollamaImageTag ?? "0.6.2");
  // pulumi.all's tuple overloads stop at 8 elements; bundling the ollama trio
  // into one output keeps the outer all an 8-tuple, so it stays heterogeneously
  // typed (the boolean enabled flag alongside the string config) rather than
  // collapsing to the homogeneous-array overload that rejects the boolean.
  const ollama = pulumi
    .all([ollamaEnabled, ollamaModel, ollamaImageTag])
    .apply(([enabled, model, imageTag]) => ({ enabled, model, imageTag }));

  return pulumi
    .all([
      repositoryUrl,
      imageTag,
      pubSubEndpoint,
      cacheEndpoint,
      logGroupName,
      secretArns,
      corsAllowedOrigins,
      ollama,
    ])
    .apply(
      ([
        repositoryUrl,
        imageTag,
        pubSubEndpoint,
        cacheEndpoint,
        logGroupName,
        secretArns,
        corsAllowedOrigins,
        ollama,
      ]) => {
        const {
          enabled: ollamaEnabled,
          model: ollamaModel,
          imageTag: ollamaImageTag,
        } = ollama;
        const backendEnv: Array<{ name: string; value: string }> = [
          {
            name: "REDIS_PUBSUB_URL",
            value: `rediss://${pubSubEndpoint}:6379`,
          },
          {
            name: "REDIS_CACHE_URL",
            value: `rediss://${cacheEndpoint}:6379`,
          },
          {
            name: "SUI_RPC_URL",
            value: "https://fullnode.testnet.sui.io:443",
          },
          {
            name: "TUNNEL_PACKAGE_ID",
            value:
              "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b",
          },
          // Slim example-app packages whose ops the sponsor gas-funds when set.
          {
            name: "AGENT_ALLOWANCE_PACKAGE_ID",
            value:
              "0x36d982ffdcf89c709829650bd6b07128f505f41d8953f48658746291d5bfb679",
          },
          {
            name: "STREAMING_PAYMENT_PACKAGE_ID",
            value:
              "0x5125f1e0b65ba5c27cc5eb130ee34133bf55ddc30322cf7099d748f4df23e7ea",
          },
          // The sponsor only gas-funds MTPS faucet mints + staked tunnel opens whose coin
          // type matches this; without it config defaults to 0x2::sui::SUI and /v1/sponsor 422s.
          // ADR-0023 admin-mint MTPS package — must own MTPS_ADMIN_CAP_ID below.
          {
            name: "TUNNEL_COIN_TYPE",
            value:
              "0xe0f8eae320959eb7300cb599a6e7a287355c60b299a7e80a808d9196e0aea8ea::mtps::MTPS",
          },
          // AdminCap the faucet signs admin_mint with (ADR-0023). Must be owned by the settler
          // key and belong to TUNNEL_COIN_TYPE's package; unset => both faucet routes 503.
          {
            name: "MTPS_ADMIN_CAP_ID",
            value:
              "0x7cc2d628c6ceeefb1e48502b0900eac5bc77f2dd9d170bdc339053e38b03ceae",
          },
          {
            name: "WALRUS_PUBLISHER_URL",
            value: "https://publisher.walrus-testnet.walrus.space",
          },
          {
            name: "WALRUS_AGGREGATOR_URL",
            value: "https://aggregator.walrus-testnet.walrus.space",
          },
          ...(corsAllowedOrigins
            ? [
                {
                  name: "CORS_ALLOWED_ORIGINS",
                  value: corsAllowedOrigins,
                },
              ]
            : []),
        ];

        if (ollamaEnabled) {
          backendEnv.push(
            // Co-located arena fleet (ADR-0027): bots spawned on demand, capped at COUNT concurrent
            // matches per served game. Sized to the funded wallet-pool prefix (~5k members) — each
            // concurrent match consumes one funded seat-B wallet, so keep COUNT x served-games <=
            // WALLET_POOL_FUNDED_COUNT. GAMES is the served-set gate (only games with a wired+funded
            // path). Wallet-pool wiring (WALLET_POOL_* + the passphrase secret + S3 task-role access)
            // is a separate change.
            { name: "FLEET_COLOCATED_COUNT", value: "5000" },
            {
              name: "FLEET_COLOCATED_GAMES",
              value:
                "quantum_poker,bomb_it,chicken_cross,world_canvas,blackjack,tic_tac_toe,caro,battleship",
            },
            // Funded seat-B wallet pool (PR #124), non-secret env. The opener self-signs each open as
            // a checked-out funded member (replaces FLEET_BOT_KEY). REQUIRES, additionally: the
            // passphrase as a Secrets Manager secret (WALLET_POOL_ACCESS_VALUE via backendSecrets) and
            // s3:GetObject on the bucket granted to the task role. Without those the open fails and the
            // opener degrades to Noop (backend stays up). FUNDED_COUNT = the funded prefix size.
            { name: "WALLET_POOL_ID", value: "wp_cjmok4DQgZDpAooCGNjmqg" },
            {
              name: "WALLET_POOL_S3_BUCKET",
              value: "dev-env-dopamint-wallet-pool",
            },
            { name: "WALLET_POOL_FUNDED_COUNT", value: "5000" },
            // The in-container AWS SDK (S3WalletPoolStore::from_env) needs an explicit region; ECS
            // doesn't auto-inject one. Credentials still come from the task role. Bucket is us-east-1.
            { name: "AWS_REGION", value: aws.config.region ?? "us-east-1" },
            { name: "OLLAMA_URL", value: "http://localhost:11434" },
            { name: "OLLAMA_MODEL", value: ollamaModel },
          );
        }

        // Secrets injected from Secrets Manager at launch — never inlined as plaintext env
        // (a task definition is readable via ecs:DescribeTaskDefinition / committed to git).
        const backendSecrets: Array<{ name: string; valueFrom: string }> = [];
        if (secretArns.settler) {
          backendSecrets.push({
            name: "SUI_SETTLER_KEY",
            valueFrom: secretArns.settler,
          });
        }
        if (secretArns.faucetAdminToken) {
          backendSecrets.push({
            name: "FAUCET_ADMIN_TOKEN",
            valueFrom: secretArns.faucetAdminToken,
          });
        }
        if (secretArns.enoki) {
          backendSecrets.push({
            name: "ENOKI_API_KEY",
            valueFrom: secretArns.enoki,
          });
        }
        if (secretArns.walletPoolAccess) {
          backendSecrets.push({
            name: "WALLET_POOL_ACCESS_VALUE",
            valueFrom: secretArns.walletPoolAccess,
          });
        }

        const backendContainer = {
          name: "backend",
          image: `${repositoryUrl}:${imageTag}`,
          essential: true,
          portMappings: [{ containerPort: 8080, protocol: "tcp" }],
          environment: backendEnv,
          ...(backendSecrets.length > 0 ? { secrets: backendSecrets } : {}),
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroupName,
              "awslogs-region": aws.config.region ?? "us-east-1",
              "awslogs-stream-prefix": "backend",
            },
          },
          healthCheck: {
            command: [
              "CMD-SHELL",
              "curl -f http://localhost:8080/health/live || exit 1",
            ],
            interval: 30,
            timeout: 5,
            retries: 3,
            startPeriod: 60,
          },
          stopTimeout: 30,
        };

        const containers: unknown[] = [backendContainer];

        if (ollamaEnabled) {
          containers.push({
            name: "ollama",
            image: `ollama/ollama:${ollamaImageTag}`,
            essential: false,
            portMappings: [{ containerPort: 11434, protocol: "tcp" }],
            environment: [{ name: "OLLAMA_KEEP_ALIVE", value: "-1" }],
            // Override the image entrypoint so we can pull the model before serving.
            entryPoint: ["/bin/sh", "-c"],
            command: [
              `ollama serve & sleep 5 && ollama pull ${ollamaModel} && wait`,
            ],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": logGroupName,
                "awslogs-region": aws.config.region ?? "us-east-1",
                "awslogs-stream-prefix": "ollama",
              },
            },
            healthCheck: {
              command: ["CMD-SHELL", "ollama list >/dev/null 2>&1 || exit 1"],
              interval: 30,
              timeout: 10,
              retries: 5,
              startPeriod: 180,
            },
            stopTimeout: 30,
          });
        }

        return JSON.stringify(containers);
      },
    );
}

function makeMigrationContainerDefinitions(
  args: BackendArgs,
): pulumi.Output<string> {
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
      ]),
    );
}

export function createBackend(args: BackendArgs): BackendOutputs {
  const name = args.name;
  const containerDefinitions = makeContainerDefinitions(args);
  const migrationContainerDefinitions = makeMigrationContainerDefinitions(args);

  const ollamaEnabled = pulumi.output(args.ollamaEnabled ?? false);
  const taskCpu = ollamaEnabled.apply((enabled) => (enabled ? "2048" : "1024"));
  const taskMemory = ollamaEnabled.apply((enabled) =>
    enabled ? "4096" : "2048",
  );

  const taskDefinition = new aws.ecs.TaskDefinition(`${name}-backend-td`, {
    family: `${name}-backend`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: taskCpu,
    memory: taskMemory,
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    executionRoleArn: args.taskExecutionRoleArn,
    taskRoleArn: args.taskRoleArn,
    containerDefinitions,
  });

  const migrationTaskDefinition = new aws.ecs.TaskDefinition(
    `${name}-backend-migrate-td`,
    {
      family: `${name}-backend-migrate`,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: "1024",
      memory: "2048",
      runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
      },
      executionRoleArn: args.taskExecutionRoleArn,
      taskRoleArn: args.taskRoleArn,
      containerDefinitions: migrationContainerDefinitions,
    },
  );

  return {
    taskDefinition,
    taskDefinitionArn: taskDefinition.arn,
    migrationTaskDefinition,
    migrationTaskDefinitionArn: migrationTaskDefinition.arn,
  };
}
