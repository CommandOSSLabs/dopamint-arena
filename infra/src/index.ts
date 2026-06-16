import * as pulumi from "@pulumi/pulumi";
import { getConfig } from "./config.js";
import { createNetwork } from "./components/Network.js";
import { createDns } from "./components/Dns.js";
import { createSecurityGroups } from "./resources/security-groups.js";

const cfg = getConfig();
const network = createNetwork(`dopamint-${cfg.environment}`);
const sgs = createSecurityGroups(`dopamint-${cfg.environment}`, network.vpcId);

const dns = createDns(`dopamint-${cfg.environment}`, {
  domain: cfg.domain,
  route53ZoneId: cfg.route53ZoneId,
});

export const vpcId = network.vpcId;
export const privateSubnetIds = network.privateSubnetIds;
export const publicSubnetIds = network.publicSubnetIds;
export const certificateArn = dns.certificateArn;
