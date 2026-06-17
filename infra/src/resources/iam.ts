import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface IamOutputs {
  taskExecutionRole: aws.iam.Role;
  taskRole: aws.iam.Role;
  githubDeployRoleArn: pulumi.Output<string>;
  imageBuilderRole: aws.iam.Role;
  imageBuilderProfile: aws.iam.InstanceProfile;
  benchmarkInstanceProfile: aws.iam.InstanceProfile;
}

export interface IamInputs {
  githubOrg: string;
  githubRepo: string;
  dbSecretArn?: pulumi.Input<string>;
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
    managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"],
  });

  if (args.dbSecretArn) {
    new aws.iam.RolePolicy(`${name}-task-exec-secrets-policy`, {
      role: taskExecutionRole.id,
      policy: pulumi.output(args.dbSecretArn).apply((secretArn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["secretsmanager:GetSecretValue"],
              Resource: secretArn,
            },
          ],
        })
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

  const githubProvider = new aws.iam.OpenIdConnectProvider(`${name}-github-oidc`, {
    url: "https://token.actions.githubusercontent.com",
    clientIdLists: ["sts.amazonaws.com"],
    thumbprintLists: ["6938fd4e98bab03faadb97b34396831e3780aea1"],
  });

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
                StringLike: { "token.actions.githubusercontent.com:sub": `repo:${org}/${repo}:*` },
                StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
              },
            },
          ],
        })
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
            "s3:*",
            "cloudfront:*",
            "logs:*",
            "elasticache:*",
            "rds:*",
            "ec2:*",
            "secretsmanager:GetSecretValue",
            "iam:PassRole",
          ],
          Resource: "*",
        },
      ],
    }),
  });

  const imageBuilderRole = new aws.iam.Role(`${name}-image-builder-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" },
        { Effect: "Allow", Principal: { Service: "imagebuilder.amazonaws.com" }, Action: "sts:AssumeRole" },
      ],
    }),
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      "arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder",
    ],
  });

  const imageBuilderProfile = new aws.iam.InstanceProfile(`${name}-image-builder-profile`, {
    role: imageBuilderRole.name,
  });

  const benchmarkRole = new aws.iam.Role(`${name}-benchmark-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" },
      ],
    }),
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
    ],
  });

  const benchmarkInstanceProfile = new aws.iam.InstanceProfile(`${name}-benchmark-profile`, {
    role: benchmarkRole.name,
  });

  return {
    taskExecutionRole,
    taskRole,
    githubDeployRoleArn: githubDeployRole.arn,
    imageBuilderRole,
    imageBuilderProfile,
    benchmarkInstanceProfile,
  };
}
