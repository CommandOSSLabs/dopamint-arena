import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";

export interface NetworkOutputs {
  vpcId: pulumi.Output<string>;
  publicSubnetIds: pulumi.Output<string[]>;
  privateSubnetIds: pulumi.Output<string[]>;
}

export function createNetwork(name: string): NetworkOutputs {
  const vpc = new awsx.ec2.Vpc(name, {
    numberOfAvailabilityZones: 3,
    natGateways: { strategy: "OnePerAz" },
    subnetSpecs: [
      { type: "Public", name: "public" },
      { type: "Private", name: "private" },
    ],
    tags: { Name: name },
  });

  return {
    vpcId: vpc.vpcId,
    publicSubnetIds: vpc.publicSubnetIds,
    privateSubnetIds: vpc.privateSubnetIds,
  };
}
