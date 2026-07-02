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
  },
): AlbOutputs {
  const alb = new aws.lb.LoadBalancer(`${name}-alb`, {
    loadBalancerType: "application",
    internal: false,
    securityGroups: [args.securityGroupId],
    subnets: args.subnetIds,
  });

  const targetGroup = new aws.lb.TargetGroup(`${name}-backend-tg`, {
    port: 8080,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: args.vpcId,
    // Pin a browser to the instance running its co-located bot. The `/v1/mp` WS handshake sets an
    // `aff` cookie (ws.rs `mp_upgrade`), CloudFront forwards it to this TG (Managed-AllViewer), and
    // app-cookie stickiness on `aff` keeps a reload/reconnect on the same target — so the resume
    // `resync` reaches the in-process bot instead of hopping cross-instance (best-effort pub/sub).
    // Codified here (not a console/CLI toggle) so a Pulumi apply can't reconcile it away. Same-origin
    // (CloudFront proxies /v1/*), so the Lax cookie suffices; a cross-origin split would additionally
    // need `SameSite=None; Secure` on the cookie and `credentials: "include"` on the FE.
    stickiness: {
      enabled: true,
      type: "app_cookie",
      cookieName: "aff",
      cookieDuration: 86400, // seconds (app_cookie allows 1..604800); one day covers a play session.
    },
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
