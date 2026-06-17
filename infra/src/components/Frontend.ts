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

  const distribution = new aws.cloudfront.Distribution(`${name}-cdn`, {
    enabled: true,
    aliases: args.certificateArn ? [args.domain] : undefined,
    origins: [
      {
        domainName: bucket.bucketRegionalDomainName,
        originId: "s3-origin",
        s3OriginConfig: { originAccessIdentity: originAccessIdentity.cloudfrontAccessIdentityPath },
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
