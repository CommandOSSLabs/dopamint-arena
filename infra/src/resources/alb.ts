import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface AlbOutputs {
  alb: aws.lb.LoadBalancer;
  listener: aws.lb.Listener;
  targetGroup: aws.lb.TargetGroup;
}

export function createAlb(
  name: string,
  args: {
    vpcId: pulumi.Input<string>;
    subnetIds: pulumi.Input<string[]>;
    securityGroupId: pulumi.Input<string>;
    certificateArn?: pulumi.Input<string>;
  }
): AlbOutputs {
  const alb = new aws.lb.LoadBalancer(`${name}-alb`, {
    loadBalancerType: "application",
    internal: false,
    securityGroups: [args.securityGroupId],
    subnets: args.subnetIds,
    // Defense-in-depth for the /v1/mp WebSocket: the 60s default reaps quiet
    // matches between turns. The server-side keepalive ping is the real fix;
    // this just widens the window. In-place attribute update, no recreation.
    idleTimeout: 300,
  });

  const targetGroup = new aws.lb.TargetGroup(`${name}-backend-tg`, {
    port: 8080,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: args.vpcId,
    healthCheck: {
      path: "/health/ready",
      port: "8080",
      protocol: "HTTP",
      healthyThreshold: 2,
      unhealthyThreshold: 3,
      interval: 30,
      timeout: 5,
    },
  });

  if (args.certificateArn) {
    const httpsListener = new aws.lb.Listener(`${name}-https`, {
      loadBalancerArn: alb.arn,
      port: 443,
      protocol: "HTTPS",
      certificateArn: args.certificateArn,
      defaultActions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
    });

    new aws.lb.Listener(`${name}-http-redirect`, {
      loadBalancerArn: alb.arn,
      port: 80,
      protocol: "HTTP",
      defaultActions: [
        {
          type: "redirect",
          redirect: { protocol: "HTTPS", port: "443", statusCode: "HTTP_301" },
        },
      ],
    });

    return { alb, listener: httpsListener, targetGroup };
  }

  const httpListener = new aws.lb.Listener(`${name}-http`, {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{ type: "forward", targetGroupArn: targetGroup.arn }],
  });

  return { alb, listener: httpListener, targetGroup };
}
