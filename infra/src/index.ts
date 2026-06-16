import * as pulumi from "@pulumi/pulumi";
import { getConfig } from "./config.js";
import { createNetwork } from "./components/Network.js";

const cfg = getConfig();
const network = createNetwork(`dopamint-${cfg.environment}`);

export const vpcId = network.vpcId;
export const privateSubnetIds = network.privateSubnetIds;
export const publicSubnetIds = network.publicSubnetIds;
