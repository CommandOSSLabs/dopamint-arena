import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BenchmarkFleetOutputs {
  imageBuilderRoleArn: pulumi.Output<string>;
  imageBuilderProfileName: pulumi.Output<string>;
  componentArn: pulumi.Output<string>;
}

export interface BenchmarkFleetArgs {
  name: string;
  imageBuilderRoleArn: pulumi.Input<string>;
  imageBuilderProfileName: pulumi.Input<string>;
}

export function createBenchmarkFleet(args: BenchmarkFleetArgs): BenchmarkFleetOutputs {
  const component = new aws.imagebuilder.Component(`${args.name}-benchmark-component`, {
    platform: "Linux",
    version: "1.0.0",
    data: `schemaVersion: 1.0
name: dopamint-benchmark-setup
description: Install benchmark dependencies
phases:
  - name: build
    steps:
      - name: InstallPackages
        action: ExecuteBash
        inputs:
          commands:
            - dnf install -y nodejs22 npm git
            - npm install -g pnpm
`,
    supportedOsVersions: ["Amazon Linux 2023"],
  });

  return {
    imageBuilderRoleArn: pulumi.output(args.imageBuilderRoleArn),
    imageBuilderProfileName: pulumi.output(args.imageBuilderProfileName),
    componentArn: component.arn,
  };
}
