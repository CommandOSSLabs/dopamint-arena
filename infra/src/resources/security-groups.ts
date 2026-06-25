import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface SecurityGroupSet {
  alb: aws.ec2.SecurityGroup;
  backend: aws.ec2.SecurityGroup;
  db: aws.ec2.SecurityGroup;
  cache: aws.ec2.SecurityGroup;
  benchmark: aws.ec2.SecurityGroup;
}

export function createSecurityGroups(
  name: string,
  vpcId: pulumi.Input<string>,
): SecurityGroupSet {
  const alb = new aws.ec2.SecurityGroup(`${name}-alb-sg`, {
    vpcId,
    description: "ALB ingress",
    ingress: [
      { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
      {
        protocol: "tcp",
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
    egress: [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
  });

  const backend = new aws.ec2.SecurityGroup(`${name}-backend-sg`, {
    vpcId,
    description: "Backend Fargate tasks",
    ingress: [
      {
        protocol: "tcp",
        fromPort: 8080,
        toPort: 8080,
        securityGroups: [alb.id],
      },
    ],
    egress: [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
  });

  const db = new aws.ec2.SecurityGroup(`${name}-db-sg`, {
    vpcId,
    description: "Aurora PostgreSQL",
    ingress: [
      {
        protocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        securityGroups: [backend.id],
      },
      { protocol: "tcp", fromPort: 5432, toPort: 5432, self: true },
    ],
    egress: [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
  });

  const benchmark = new aws.ec2.SecurityGroup(`${name}-benchmark-sg`, {
    vpcId,
    description: "Benchmark fleet",
    egress: [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
  });

  const cache = new aws.ec2.SecurityGroup(`${name}-cache-sg`, {
    vpcId,
    description: "ElastiCache Redis",
    ingress: [
      {
        protocol: "tcp",
        fromPort: 6379,
        toPort: 6379,
        securityGroups: [backend.id],
      },
      {
        protocol: "tcp",
        fromPort: 6379,
        toPort: 6379,
        securityGroups: [benchmark.id],
      },
    ],
  });

  return { alb, backend, db, cache, benchmark };
}
