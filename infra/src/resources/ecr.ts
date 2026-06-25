import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface EcrOutputs {
  repositoryUrl: pulumi.Output<string>;
  repositoryArn: pulumi.Output<string>;
}

export function createEcr(name: string): EcrOutputs {
  const repo = new aws.ecr.Repository(`${name}-backend`, {
    imageTagMutability: "MUTABLE",
    imageScanningConfiguration: { scanOnPush: true },
    forceDelete: true,
  });

  new aws.ecr.LifecyclePolicy(`${name}-backend-lifecycle`, {
    repository: repo.name,
    policy: JSON.stringify({
      rules: [
        {
          rulePriority: 1,
          description: "Keep last 30 images",
          selection: {
            tagStatus: "any",
            countType: "imageCountMoreThan",
            countNumber: 30,
          },
          action: { type: "expire" },
        },
      ],
    }),
  });

  return { repositoryUrl: repo.repositoryUrl, repositoryArn: repo.arn };
}
