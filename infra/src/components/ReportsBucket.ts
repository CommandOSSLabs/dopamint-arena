import * as aws from "@pulumi/aws";

export function createReportsBucket(name: string): aws.s3.Bucket {
  return new aws.s3.Bucket(name, {
    versioning: { enabled: true },
    lifecycleRules: [
      {
        enabled: true,
        expiration: { days: 30 },
      },
    ],
  });
}
