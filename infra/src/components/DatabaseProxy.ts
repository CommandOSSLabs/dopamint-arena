import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface DatabaseProxyOutputs {
  proxyEndpoint: pulumi.Output<string>;
}

export function createDatabaseProxy(
  name: string,
  args: {
    vpcId: pulumi.Input<string>;
    subnetIds: pulumi.Input<string[]>;
    securityGroupId: pulumi.Input<string>;
    dbClusterIdentifier: pulumi.Input<string>;
    secretArn: pulumi.Input<string>;
  }
): DatabaseProxyOutputs {
  const role = new aws.iam.Role(`${name}-rds-proxy-role`, {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "rds.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    }),
  });

  new aws.iam.RolePolicy(`${name}-rds-proxy-policy`, {
    role: role.id,
    policy: pulumi.all([args.secretArn]).apply(([secretArn]) =>
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

  const proxy = new aws.rds.Proxy(`${name}-rds-proxy`, {
    engineFamily: "POSTGRESQL",
    roleArn: role.arn,
    vpcSubnetIds: args.subnetIds,
    vpcSecurityGroupIds: [args.securityGroupId],
    auths: [
      {
        authScheme: "SECRETS",
        secretArn: args.secretArn,
        iamAuth: "DISABLED",
      },
    ],
  });

  new aws.rds.ProxyTarget(`${name}-rds-proxy-target`, {
    dbClusterIdentifier: args.dbClusterIdentifier,
    dbProxyName: proxy.name,
    targetGroupName: "default",
  });

  return { proxyEndpoint: proxy.endpoint };
}
