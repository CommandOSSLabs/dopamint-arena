import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface FrontendOutputs {
  bucketName: pulumi.Output<string>;
  distributionId: pulumi.Output<string>;
  distributionDomain: pulumi.Output<string>;
}

export function createFrontend(
  name: string,
  args: {
    domain: string;
    albDnsName: pulumi.Input<string>;
    certificateArn?: pulumi.Input<string>;
    zoneId?: pulumi.Input<string>;
  }
): FrontendOutputs {
  const bucket = new aws.s3.BucketV2(`${name}-frontend`, {
    bucket: `${name}-frontend-${pulumi.getStack()}`,
  });

  new aws.s3.BucketVersioningV2(`${name}-frontend-versioning`, {
    bucket: bucket.id,
    versioningConfiguration: { status: "Enabled" },
  });

  new aws.s3.BucketPublicAccessBlock(`${name}-frontend-public`, {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  const originAccessIdentity = new aws.cloudfront.OriginAccessIdentity(`${name}-oai`, {
    comment: `OAI for ${name}`,
  });

  new aws.s3.BucketPolicy(`${name}-frontend-policy`, {
    bucket: bucket.id,
    policy: pulumi.all([bucket.arn, originAccessIdentity.iamArn]).apply(([arn, oaiArn]) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCloudFrontOAI",
            Effect: "Allow",
            Principal: { AWS: [oaiArn] },
            Action: "s3:GetObject",
            Resource: `${arn}/*`,
          },
        ],
      })
    ),
  });

  // Same-origin backend: CloudFront proxies /v1/* to the ALB so the SPA, its SSE feed
  // (/v1/stats/live) and the PvP WebSocket (/v1/mp) all share one HTTPS origin
  // (ADR-0002/0004). Without this the SPA 403->/index.html fallback answers every
  // /v1/* request with text/html, which breaks the SSE MIME type and the WS upgrade.
  // Cert present (staging/prod): target the api.<domain> alias over HTTPS — the cert's
  // *.<domain> SAN covers it, so CloudFront's origin-cert hostname check passes.
  // No cert (dev): the ALB only has an HTTP:80 listener, so connect over http.
  // The HTTPS branch is unverified in dev (no cert exists there).
  const albOriginDomain = args.certificateArn ? `api.${args.domain}` : args.albDnsName;

  // Managed policies: disable caching (required for SSE streaming and WS) and forward the
  // full viewer request (Authorization + Sec-WebSocket-* headers, cookies, query string).
  const cachingDisabled = aws.cloudfront.getCachePolicyOutput({ name: "Managed-CachingDisabled" });
  const allViewer = aws.cloudfront.getOriginRequestPolicyOutput({ name: "Managed-AllViewer" });

  const distribution = new aws.cloudfront.Distribution(`${name}-cdn`, {
    enabled: true,
    aliases: args.certificateArn ? [args.domain] : undefined,
    origins: [
      {
        domainName: bucket.bucketRegionalDomainName,
        originId: "s3-origin",
        s3OriginConfig: { originAccessIdentity: originAccessIdentity.cloudfrontAccessIdentityPath },
      },
      {
        domainName: albOriginDomain,
        originId: "alb-origin",
        customOriginConfig: {
          httpPort: 80,
          httpsPort: 443,
          originProtocolPolicy: args.certificateArn ? "https-only" : "http-only",
          originSslProtocols: ["TLSv1.2"],
        },
      },
    ],
    orderedCacheBehaviors: [
      {
        pathPattern: "/v1/*",
        targetOriginId: "alb-origin",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        cachedMethods: ["GET", "HEAD"],
        compress: false,
        cachePolicyId: cachingDisabled.id,
        originRequestPolicyId: allViewer.id,
      },
    ],
    defaultRootObject: "index.html",
    defaultCacheBehavior: {
      allowedMethods: ["GET", "HEAD", "OPTIONS"],
      cachedMethods: ["GET", "HEAD"],
      targetOriginId: "s3-origin",
      forwardedValues: { queryString: false, cookies: { forward: "none" } },
      viewerProtocolPolicy: "redirect-to-https",
      minTtl: 0,
      defaultTtl: 3600,
      maxTtl: 86400,
    },
    restrictions: { geoRestriction: { restrictionType: "none" } },
    viewerCertificate: args.certificateArn
      ? {
          acmCertificateArn: args.certificateArn,
          sslSupportMethod: "sni-only",
          minimumProtocolVersion: "TLSv1.2_2021",
        }
      : {
          cloudfrontDefaultCertificate: true,
        },
    customErrorResponses: [
      { errorCode: 403, responseCode: 200, responsePagePath: "/index.html" },
      { errorCode: 404, responseCode: 200, responsePagePath: "/index.html" },
    ],
  });

  if (args.zoneId) {
    new aws.route53.Record(`${name}-frontend-alias`, {
      zoneId: args.zoneId,
      name: args.domain,
      type: "A",
      aliases: [
        {
          name: distribution.domainName,
          zoneId: distribution.hostedZoneId,
          evaluateTargetHealth: false,
        },
      ],
    });
  }

  return {
    bucketName: bucket.id,
    distributionId: distribution.id,
    distributionDomain: distribution.domainName,
  };
}
