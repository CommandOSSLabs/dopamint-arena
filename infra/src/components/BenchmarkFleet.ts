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

  const imageRecipe = new aws.imagebuilder.ImageRecipe(`${args.name}-benchmark-recipe`, {
    parentImage: baseAmi.id,
    version,
    components: [{ componentArn: component.arn }],
  });

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
    userData: pulumi.interpolate`#!/bin/bash
set -euo pipefail
cd /opt/dopamint/repo/sui-tunnel-ts || true
`.apply((data) => Buffer.from(data).toString("base64")),
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
