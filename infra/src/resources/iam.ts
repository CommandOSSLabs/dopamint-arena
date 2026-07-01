import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface IamOutputs {
  taskExecutionRole: aws.iam.Role;
  taskRole: aws.iam.Role;
  githubDeployRoleArn: pulumi.Output<string>;
}

export interface IamInputs {
  githubOrg: string;
  githubRepo: string;
  // Secret ARNs the ECS task-execution role may read to inject `secrets` at launch
  // (e.g. DB password, settler key). Scoped to exactly these resources.
  taskExecSecretArns?: pulumi.Input<string>[];
  // ARN of the transcripts bucket the tunnel-manager task role may write (ADR-0023).
  // Omitted => no S3 policy is attached (e.g. a stack without S3 archival).
  taskRoleTranscriptsBucketArn?: pulumi.Input<string>;
  // S3 bucket holding the wallet-pool blob (PR #124). The TASK role (the running container's
  // identity, used by `S3WalletPoolStore::from_env`) gets `s3:GetObject` on it. Omitted => no grant.
  walletPoolS3Bucket?: pulumi.Input<string>;
}

export function createIam(name: string, args: IamInputs): IamOutputs {
  const taskExecutionRole = new aws.iam.Role(`${name}-task-exec-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    }),
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    ],
  });

  if (args.taskExecSecretArns && args.taskExecSecretArns.length > 0) {
    new aws.iam.RolePolicy(`${name}-task-exec-secrets-policy`, {
      role: taskExecutionRole.id,
      policy: pulumi.all(args.taskExecSecretArns).apply((secretArns) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["secretsmanager:GetSecretValue"],
              Resource: secretArns,
            },
          ],
        }),
      ),
    });
  }

  const taskRole = new aws.iam.Role(`${name}-task-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    }),
    managedPolicyArns: ["arn:aws:iam::aws:policy/CloudWatchFullAccess"],
  });

  if (args.taskRoleTranscriptsBucketArn) {
    new aws.iam.RolePolicy(`${name}-task-role-s3-policy`, {
      role: taskRole.id,
      policy: pulumi
        .output(args.taskRoleTranscriptsBucketArn)
        .apply((bucketArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                // PutObject: tunnel-manager archives at settle. GetObject: the explorer API
                // (same task role) reads the archived transcript to verify from S3.
                Action: ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
                Resource: `${bucketArn}/*`,
              },
              {
                Effect: "Allow",
                Action: [
                  "s3:ListBucket",
                  "s3:GetBucketLocation",
                  "s3:ListBucketMultipartUploads",
                ],
                Resource: bucketArn,
              },
            ],
          }),
        ),
    });
  }

  // Wallet pool (PR #124): the running backend reads the pool blob from S3 via the task role's
  // identity (default AWS credential chain). Scope to GetObject on exactly this bucket's objects.
  if (args.walletPoolS3Bucket) {
    new aws.iam.RolePolicy(`${name}-task-wallet-pool-s3`, {
      role: taskRole.id,
      policy: pulumi.output(args.walletPoolS3Bucket).apply((bucket) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [`arn:aws:s3:::${bucket}/*`],
            },
          ],
        }),
      ),
    });
  }

  const githubProvider = new aws.iam.OpenIdConnectProvider(
    `${name}-github-oidc`,
    {
      url: "https://token.actions.githubusercontent.com",
      clientIdLists: ["sts.amazonaws.com"],
      thumbprintLists: ["6938fd4e98bab03faadb97b34396831e3780aea1"],
    },
  );

  const githubDeployRole = new aws.iam.Role(`${name}-github-deploy-role`, {
    assumeRolePolicy: pulumi
      .all([githubProvider.arn, args.githubOrg, args.githubRepo])
      .apply(([providerArn, org, repo]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Federated: providerArn },
              Action: "sts:AssumeRoleWithWebIdentity",
              Condition: {
                StringLike: {
                  "token.actions.githubusercontent.com:sub": `repo:${org}/${repo}:*`,
                },
                StringEquals: {
                  "token.actions.githubusercontent.com:aud":
                    "sts.amazonaws.com",
                },
              },
            },
          ],
        }),
      ),
  });

  new aws.iam.RolePolicy(`${name}-github-deploy-policy`, {
    role: githubDeployRole.id,
    policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "ecr:*",
            "ecs:*",
            "application-autoscaling:*",
            "s3:*",
            "cloudfront:*",
            "logs:*",
            "cloudwatch:*",
            "elasticache:*",
            "rds:*",
            "ec2:*",
            "elasticloadbalancing:*",
            "secretsmanager:*",
            "iam:*",
          ],
          Resource: "*",
        },
      ],
    }),
  });

  return {
    taskExecutionRole,
    taskRole,
    githubDeployRoleArn: githubDeployRole.arn,
  };
}
