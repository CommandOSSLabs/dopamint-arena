import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BenchmarkFleetOutputs {
  asgName: pulumi.Output<string>;
  componentArn: pulumi.Output<string>;
  imageRecipeArn: pulumi.Output<string>;
  pipelineArn: pulumi.Output<string>;
}

export interface BenchmarkFleetArgs {
  name: string;
  benchmarkInstanceProfileArn: pulumi.Input<string>;
  imageBuilderProfileName: pulumi.Input<string>;
  instanceType: pulumi.Input<string>;
  maxSize: number;
  minSize: number;
  securityGroupId: pulumi.Input<string>;
  subnetIds: pulumi.Input<string[]>;
  /**
   * Semantic version for the Image Builder component and recipe.
   * Must be bumped whenever the inline component YAML changes, because
   * Image Builder components and recipes are immutable by semantic version.
   */
  version: pulumi.Input<string>;
  /** WebSocket URL the generators connect to, e.g. ws://alb/v1/mp. */
  backendUrl: pulumi.Input<string>;
  /** S3 bucket used for the start signal and per-instance reports. */
  reportsBucketName: pulumi.Input<string>;
  /** S3 key for the sui-tunnel-ts code artifact (default: artifact/sui-tunnel-ts.zip). */
  artifactKey?: pulumi.Input<string>;
  /** Number of tic-tac-toe pairs each instance plays (default: 100). */
  pairsPerInstance?: pulumi.Input<number>;
  /** Duration of each instance's test run in milliseconds (default: 30000). */
  durationMs?: pulumi.Input<number>;
  /** AWS region for S3/SSM (default: us-east-1). */
  region?: pulumi.Input<string>;
}

export function createBenchmarkFleet(args: BenchmarkFleetArgs): BenchmarkFleetOutputs {
  const version = args.version;

  const component = new aws.imagebuilder.Component(`${args.name}-benchmark-component`, {
    platform: "Linux",
    version,
    data: `
name: DopamintBenchmarkSetup
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: InstallNode
        action: ExecuteBash
        inputs:
          commands:
            - set -euo pipefail
            - yum update -y
            - yum install -y nodejs20 npm git numactl
            - npm install -g pnpm tsx ts-node
      - name: CloneRepo
        action: ExecuteBash
        inputs:
          commands:
            - mkdir -p /opt/dopamint
            - cd /opt/dopamint
            - git clone --depth 1 https://github.com/CommandOSSLabs/dopamint-arena.git repo
            - cd repo/sui-tunnel-ts
            - pnpm install --frozen-lockfile
`,
    supportedOsVersions: ["Amazon Linux 2023"],
  });

  const baseAmi = aws.ec2.getAmiOutput({
    mostRecent: true,
    owners: ["amazon"],
    filters: [
      { name: "name", values: ["al2023-ami-*-x86_64"] },
      { name: "virtualization-type", values: ["hvm"] },
    ],
  });

  const imageRecipe = new aws.imagebuilder.ImageRecipe(
    `${args.name}-benchmark-recipe`,
    {
      parentImage: baseAmi.id,
      version,
      components: [{ componentArn: component.arn }],
      blockDeviceMappings: [
        {
          deviceName: "/dev/xvda",
          ebs: {
            volumeSize: 20,
            volumeType: "gp3",
            deleteOnTermination: "true",
          },
        },
      ],
    },
    { ignoreChanges: ["parentImage"] }
  );

  const distribution = new aws.imagebuilder.DistributionConfiguration(`${args.name}-benchmark-dist`, {
    distributions: [
      {
        region: aws.getRegionOutput().name,
        amiDistributionConfiguration: { name: `${args.name}-benchmark-{{ imagebuilder:buildDate }}` },
      },
    ],
  });

  const infraConfig = new aws.imagebuilder.InfrastructureConfiguration(`${args.name}-benchmark-infra`, {
    instanceProfileName: args.imageBuilderProfileName,
    instanceTypes: [args.instanceType],
    securityGroupIds: [args.securityGroupId],
    subnetId: pulumi.output(args.subnetIds).apply((ids) => {
      if (ids.length === 0) {
        throw new Error("At least one subnet is required for the benchmark Image Builder infrastructure configuration");
      }
      return ids[0];
    }),
  });

  const pipeline = new aws.imagebuilder.ImagePipeline(`${args.name}-benchmark-pipeline`, {
    imageRecipeArn: imageRecipe.arn,
    infrastructureConfigurationArn: infraConfig.arn,
    distributionConfigurationArn: distribution.arn,
  });

  const initialBuild = new aws.imagebuilder.Image(`${args.name}-benchmark-initial-image`, {
    imageRecipeArn: imageRecipe.arn,
    infrastructureConfigurationArn: infraConfig.arn,
    distributionConfigurationArn: distribution.arn,
  });

  const builtAmiId = initialBuild.outputResources.apply((resources) => {
    const ami = resources[0]?.amis?.[0]?.image;
    if (!ami) {
      throw new Error("Image Builder did not produce an AMI for the benchmark fleet");
    }
    return ami;
  });

  const launchTemplate = new aws.ec2.LaunchTemplate(`${args.name}-benchmark-lt`, {
    imageId: builtAmiId,
    instanceType: args.instanceType,
    vpcSecurityGroupIds: [args.securityGroupId],
    iamInstanceProfile: { arn: args.benchmarkInstanceProfileArn },
    userData: pulumi
      .all([
        args.backendUrl,
        args.reportsBucketName,
        args.artifactKey ?? "artifact/sui-tunnel-ts.zip",
        args.pairsPerInstance ?? 100,
        args.durationMs ?? 30000,
        args.region ?? "us-east-1",
      ])
      .apply(
        ([backendUrl, bucket, artifactKey, pairs, durationMs, region]) =>
          Buffer.from(
            `#!/bin/bash
set -euo pipefail
exec > >(tee /var/log/dopamint-bench.log) 2>&1

# The AL2023 minimal AMI omits the SSM agent, but we want SSM access for debugging.
if ! command -v amazon-ssm-agent >/dev/null 2>&1; then
  dnf install -y amazon-ssm-agent || true
fi
systemctl enable --now amazon-ssm-agent || true

# Make sure the AWS CLI and unzip are present for the code artifact download.
dnf install -y awscli2 unzip || dnf install -y awscli unzip || true

BUCKET="${bucket}"
ARTIFACT_KEY="${artifactKey}"
RUN_DIR="/opt/dopamint/bench"
mkdir -p "$RUN_DIR"
cd "$RUN_DIR"

# Wait for the deployer to publish the code artifact.
for i in $(seq 1 120); do
  if aws s3 cp "s3://$BUCKET/$ARTIFACT_KEY" ./sui-tunnel-ts.zip 2>/dev/null; then
    echo "downloaded code artifact s3://$BUCKET/$ARTIFACT_KEY"
    break
  fi
  echo "waiting for code artifact s3://$BUCKET/$ARTIFACT_KEY"
  sleep 5
done

unzip -o sui-tunnel-ts.zip -d sui-tunnel-ts
cd sui-tunnel-ts

# Install runtime dependencies (the artifact excludes node_modules).
pnpm install --frozen-lockfile

export BACKEND_URL="${backendUrl}"
export REPORTS_BUCKET="$BUCKET"
export AWS_REGION="${region}"
# The launch template requires IMDSv2, so fetch a token before reading metadata.
IMDS_TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -sf -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
export INSTANCE_ID

echo "starting load generator: instance=$INSTANCE_ID pairs=${pairs} duration=${durationMs}ms"
nohup pnpm tsx src/bench/pvpCli.ts \
  --pairs "${pairs}" \
  --duration "${durationMs}" \
  --waitForStart \
  --bucket "$REPORTS_BUCKET" \
  --instanceId "$INSTANCE_ID" \
  --region "$AWS_REGION" \
  >> /var/log/dopamint-bench.log 2>&1 &

echo "generator started as pid $!"
`,
            "utf8"
          ).toString("base64")
      ),
    metadataOptions: {
      httpEndpoint: "enabled",
      httpTokens: "required",
    },
  });

  const asg = new aws.autoscaling.Group(`${args.name}-benchmark`, {
    vpcZoneIdentifiers: args.subnetIds,
    minSize: args.minSize,
    maxSize: args.maxSize,
    desiredCapacity: args.minSize,
    launchTemplate: { id: launchTemplate.id, version: "$Latest" },
    tags: [{ key: "Name", value: `${args.name}-benchmark`, propagateAtLaunch: true }],
  });

  return {
    asgName: asg.name,
    componentArn: component.arn,
    imageRecipeArn: imageRecipe.arn,
    pipelineArn: pipeline.arn,
  };
}
