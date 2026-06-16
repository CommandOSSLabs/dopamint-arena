import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BackendAliasArgs {
  name: string;
  domain: string;
  zoneId?: pulumi.Input<string>;
  albDnsName: pulumi.Input<string>;
  albHostedZoneId: pulumi.Input<string>;
}

export function createBackendAlias(args: BackendAliasArgs): void {
  if (!args.zoneId) return;

  new aws.route53.Record(`${args.name}-backend-alias`, {
    zoneId: args.zoneId,
    name: `api.${args.domain}`,
    type: "A",
    aliases: [
      {
        name: args.albDnsName,
        zoneId: args.albHostedZoneId,
        evaluateTargetHealth: true,
      },
    ],
  });
}
