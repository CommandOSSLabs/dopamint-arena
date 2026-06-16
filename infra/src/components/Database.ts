import * as aws from "@pulumi/aws";
import * as random from "@pulumi/random";
import * as pulumi from "@pulumi/pulumi";

export interface DatabaseOutputs {
  clusterIdentifier: pulumi.Output<string>;
  clusterEndpoint: pulumi.Output<string>;
  dbSecretArn: pulumi.Output<string>; // JSON credentials for RDS Proxy
  dbPasswordSecretArn: pulumi.Output<string>; // Plaintext password for ECS
}

export function createDatabase(
  name: string,
  args: {
    subnetIds: pulumi.Input<string[]>;
    securityGroupId: pulumi.Input<string>;
    instanceClass: string;
    serverless: boolean;
    minCapacity?: number;
    maxCapacity?: number;
  }
): DatabaseOutputs {
  const dbPassword = new random.RandomPassword(`${name}-db-password`, {
    length: 32,
    special: false,
  });

  const dbSecret = new aws.secretsmanager.Secret(`${name}-db-secret`, {
    description: `Database credentials for ${name}`,
  });

  new aws.secretsmanager.SecretVersion(`${name}-db-secret-version`, {
    secretId: dbSecret.id,
    secretString: pulumi.all([dbPassword.result]).apply(([pwd]) =>
      JSON.stringify({ username: "dopamint", password: pwd })
    ),
  });

  const dbPasswordSecret = new aws.secretsmanager.Secret(`${name}-db-password-secret`, {
    description: `Database password for ${name}`,
  });

  new aws.secretsmanager.SecretVersion(`${name}-db-password-secret-version`, {
    secretId: dbPasswordSecret.id,
    secretString: dbPassword.result,
  });

  const subnetGroup = new aws.rds.SubnetGroup(`${name}-db-subnets`, {
    subnetIds: args.subnetIds,
  });

  const snapshotSuffix = new random.RandomPet(`${name}-snapshot-suffix`, { length: 2 });

  const cluster = new aws.rds.Cluster(`${name}-aurora`, {
    engine: "aurora-postgresql",
    engineVersion: "16.1",
    databaseName: "dopamint",
    masterUsername: "dopamint",
    masterPassword: dbPassword.result,
    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [args.securityGroupId],
    skipFinalSnapshot: false,
    finalSnapshotIdentifier: pulumi.interpolate`${name}-final-${snapshotSuffix.id}`.apply((s) => s.slice(0, 63)),
    backupRetentionPeriod: 7,
    preferredBackupWindow: "03:00-04:00",
    storageEncrypted: true,
    serverlessv2ScalingConfiguration: args.serverless
      ? { minCapacity: args.minCapacity ?? 0.5, maxCapacity: args.maxCapacity ?? 4 }
      : undefined,
  });

  const instanceClass = args.serverless ? "db.serverless" : args.instanceClass;
  new aws.rds.ClusterInstance(`${name}-aurora-instance`, {
    clusterIdentifier: cluster.id,
    instanceClass,
    engine: "aurora-postgresql",
    dbSubnetGroupName: subnetGroup.name,
  });

  return {
    clusterIdentifier: cluster.id,
    clusterEndpoint: cluster.endpoint,
    dbSecretArn: dbSecret.arn,
    dbPasswordSecretArn: dbPasswordSecret.arn,
  };
}
