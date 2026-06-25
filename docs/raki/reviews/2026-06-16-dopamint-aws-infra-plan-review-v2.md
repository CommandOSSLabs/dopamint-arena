# Plan Review v2: Dopamint Arena AWS Infrastructure Implementation Plan

- **Date**: 2026-06-16
- **Plan**: `docs/superpowers/plans/2026-06-16-dopamint-aws-infra-implementation-plan.md` (revised)
- **Spec**: `docs/superpowers/specs/2026-06-16-dopamint-arena-aws-deployment-design.md`
- **Effort**: high
- **Verdict**: **NO-GO**

## Summary

The revised plan fixes most of the first review's HARD-GATE findings, but a second pass still finds **12 confirmed HARD-GATE blockers**. The remaining issues are mostly in the CI/CD workflow and Pulumi/CI contract: the ECS task-definition revision strategy is broken, the migration runner does not exist, Pulumi and CI fight over the ECS service, the frontend/backend URLs mismatch TLS certificates, the benchmark fleet cannot receive SSM commands, and GitHub environment variables are incomplete. These are execution-blocking and require another revision before implementation.

## HARD-GATE Findings

### 1. BACKEND_URL uses ALB DNS name but the certificate only covers the custom domain

- **Task ref**: Task 16 / Task 20 / Task 7
- **Category**: interface-change
- **Issue**: `github.ts` exports `BACKEND_URL: https://<alb-dns-name>`, but the ACM certificate only covers `dopamint.example.com` and `*.dopamint.example.com`. Browsers will hit a TLS hostname mismatch when the frontend calls the backend.
- **Evidence**: Task 16 `githubEnvOutputs` uses `inputs.backendUrl` where `backendUrl: alb.alb.dnsName`. Task 3 creates the certificate for `args.domain` only.
- **Fix**: Export `BACKEND_URL: https://${cfg.domain}` (after adding a Route 53 alias record for the ALB), or export the ALB DNS name and add it to the certificate SANs. Prefer the custom domain.

### 2. Benchmark fleet launch template has no IAM instance profile for SSM

- **Task ref**: Task 17 / Task 21
- **Category**: coordination-gap
- **Issue**: The benchmark ASG launch template does not attach an instance profile, but the benchmark workflow uses `aws ssm send-command` to trigger the harness. SSM requires an instance profile with `AmazonSSMManagedInstanceCore`.
- **Evidence**: Task 17 launch template sets `vpcSecurityGroupIds`, `metadataOptions`, and `userData` but no `iam.instanceProfile`. Task 21 calls `aws ssm send-command --instance-ids $INSTANCE_ID`.
- **Fix**: Create a benchmark EC2 instance role/profile with `AmazonSSMManagedInstanceCore` and CloudWatch logs permissions; pass it into the launch template.

### 3. Migration job uses literal placeholders for subnets and security group

- **Task ref**: Task 20 / Task 16
- **Category**: coordination-gap
- **Issue**: The `run-task` network configuration contains `[<private-subnets>]` and `[<backend-sg>]`. These values are not exported to GitHub environment variables, so the migration task cannot be scheduled.
- **Evidence**: Task 20 Step 6 migration job: `--network-configuration 'awsvpcConfiguration={subnets=[<private-subnets>],securityGroups=[<backend-sg>],assignPublicIp=DISABLED}'`. Task 16 `githubEnvOutputs` does not include `PRIVATE_SUBNET_IDS` or `BACKEND_SECURITY_GROUP_ID`.
- **Fix**: Add `PRIVATE_SUBNET_IDS` and `BACKEND_SECURITY_GROUP_ID` to `githubEnvOutputs`; reference them via `${{ vars.* }}` in the workflow.

### 4. ECS task definition uses `:latest` but CI references a SHA-named revision

- **Task ref**: Task 13 / Task 14 / Task 20
- **Category**: interface-change
- **Issue**: Pulumi registers a task definition with `image: <ecr>:latest`. CI then runs `aws ecs update-service --task-definition dopamint-<env>-backend:${{ github.sha }}`. ECS revisions are numeric, not SHA strings, and no SHA-named revision is created.
- **Evidence**: Task 14 passes `imageTag: "latest"`. Task 20 Step 7 uses `${{ github.sha }}` as a task-definition revision identifier.
- **Fix**: Drive the image tag from a Pulumi config value (e.g., `cfg.backendImageTag`) that CI sets to the git SHA before `pulumi up`. Remove the direct `aws ecs update-service` task-definition mutation from CI.

### 5. CI and Pulumi both mutate the same ECS service

- **Task ref**: Task 20 / Task 14
- **Category**: race-condition
- **Issue**: `pulumi up` owns the ECS service and reconciles `taskDefinition`. CI also calls `aws ecs update-service` with a different task-definition revision. They will fight on every deploy. No workflow `concurrency` group exists.
- **Evidence**: Task 14 creates the service with `taskDefinition: taskDefinition.arn`. Task 20 Step 3 runs `pulumi up`; Step 7 runs `aws ecs update-service --task-definition ... --force-new-deployment`.
- **Fix**: Add `ignoreChanges: ["taskDefinition"]` to the ECS service so Pulumi manages desired count and network config while CI manages the task-definition revision. Add a workflow `concurrency` group per environment.

### 6. Migration task definition `...-backend-migrate` does not exist

- **Task ref**: Task 20 / Tasks 12–14
- **Category**: interface-change
- **Issue**: The migrate job references `dopamint-<env>-backend-migrate`, but Pulumi only creates the `dopamint-<env>-backend` task definition family.
- **Evidence**: Task 20 Step 6: `--task-definition dopamint-<env>-backend-migrate`. Tasks 12–14 create only the backend task definition and service.
- **Fix**: Add a Pulumi-managed migration task definition (or reuse the backend task definition with `--overrides` to run the migration command). Align the CI job to the actual family/revision.

### 7. Frontend S3 bucket is not versioned, making rollback impossible

- **Task ref**: Task 7 / Task 20 / Task 22
- **Category**: missing-backup
- **Issue**: The frontend bucket has no versioning, and `aws s3 sync --delete` overwrites/deletes previous artifacts. The rollback runbook's "re-sync previous versioned S3 artifact" cannot work.
- **Evidence**: Task 7 `Frontend.ts` creates `aws.s3.BucketV2` with no versioning. Task 20 deploy-frontend uses `aws s3 sync ... --delete`. Task 22 runbook references versioned artifacts.
- **Fix**: Enable S3 versioning on the frontend bucket, and/or archive each build to a versioned artifacts bucket with a SHA prefix before sync.

### 8. Migration job does not wait for the Aurora snapshot to become available

- **Task ref**: Task 20
- **Category**: unsafe-order
- **Issue**: `aws rds create-db-cluster-snapshot` is asynchronous, but the migration task runs immediately afterward. A fast migration failure could leave the snapshot unusable.
- **Evidence**: Task 20 Step 6: `create-db-cluster-snapshot` followed immediately by `aws ecs run-task` and `aws ecs wait tasks-stopped`. No `aws rds wait db-cluster-snapshot-available`.
- **Fix**: Wait for the snapshot to reach `available` before launching the migration task.

### 9. `createIam` signature is missing `dbSecretArn` but the body uses it

- **Task ref**: Task 6
- **Category**: branch-order
- **Issue**: Task 6's `createIam` declares `args: { githubOrg; githubRepo }` but immediately references `args.dbSecretArn`. TypeScript will fail until Task 10 adds the argument.
- **Evidence**: Task 6 Step 1 code block uses `args.dbSecretArn` in `new aws.iam.RolePolicy(...)`. The signature does not include it.
- **Fix**: Remove the DB-secret policy from Task 6 and add it only in Task 10 when the secret ARN is available.

### 10. GitHub environment variables are incomplete

- **Task ref**: Task 16
- **Category**: missing-prereq
- **Issue**: `githubEnvOutputs` does not export `AWS_DEPLOY_ROLE_ARN` or `BENCHMARK_ASG_NAME`, but both workflows read them from `vars`.
- **Evidence**: Task 16 returns `{ BACKEND_URL, FRONTEND_BUCKET, CLOUDFRONT_ID, ECR_URL, ECS_CLUSTER, ECS_SERVICE }`. Task 20/21 use `vars.AWS_DEPLOY_ROLE_ARN`; Task 21 uses `vars.BENCHMARK_ASG_NAME`.
- **Fix**: Add `AWS_DEPLOY_ROLE_ARN` and `BENCHMARK_ASG_NAME` (plus `PRIVATE_SUBNET_IDS` and `BACKEND_SECURITY_GROUP_ID` per finding #3) to `githubEnvOutputs`.

### 11. Image Builder launch template references a pipeline with no initial image

- **Task ref**: Task 17
- **Category**: external-dep
- **Issue**: `aws.imagebuilder.getImageOutput` queries a newly created pipeline with no builds. The data-source lookup itself can fail before the base-AMI fallback applies.
- **Evidence**: Task 17 Step 3 creates the pipeline; Step 4 calls `getImageOutput` on it.
- **Verdict**: PLAUSIBLE downgraded to WARNING — the fallback may or may not protect the data-source invocation. Treat as a risk to fix.
- **Fix**: Either trigger an initial image build and wait before creating the launch template, or initially create the ASG with the base AMI and update the launch template after the first Golden AMI build succeeds.

### 12. No post-migration schema verification

- **Task ref**: Task 20
- **Category**: data-validation-gap
- **Issue**: The migration job only checks the ECS task exit code. It does not verify schema version or integrity.
- **Evidence**: Task 20 Step 6 ends with checking `exitCode` only.
- **Verdict**: PLAUSIBLE downgraded to WARNING — migration tools typically manage their own version metadata, and the spec does not explicitly require CI-level assertions.
- **Fix**: Add a post-migration smoke test that queries the RDS Proxy endpoint for expected schema state (e.g., `schema_migrations` version).

## WARNING Findings

1. **Task 17 oversized** — still bundles Image Builder pipeline + ASG into one task.
2. **Task 20 inconsistent granularity** — workflow task still spans OIDC, filtering, infra, frontend, backend, migration, and update.
3. **Task 6 AdministratorAccess blast radius** — GitHub OIDC deploy role has full admin.
4. **Task 20 no post-deploy smoke tests** — no curl of `/health/live`, `/health/ready`, or frontend domain.
5. **Task 21 benchmark workflow does not parse TPS** — pass/fail threshold is a comment placeholder.
6. **Task 15 alarm dimensions use full ALB ARN** — CloudWatch metrics need `arnSuffix`.
7. **Task 20/18 irreversible migration on backend rollback** — no enforcement of backward-compatible migrations.
8. **Task 22 DB rollback is manual and multi-step** — no single automated rollback script.
9. **Plan-wide no time estimates** — makes the 30-minute sizing rule unverifiable.

## Required Rework

Before this plan can receive a GO verdict, fix:

1. Export the correct backend URL (`https://${cfg.domain}`) and add an ALB Route 53 alias.
2. Add an IAM instance profile for benchmark EC2 instances with SSM/CloudWatch permissions.
3. Export `PRIVATE_SUBNET_IDS`, `BACKEND_SECURITY_GROUP_ID`, `AWS_DEPLOY_ROLE_ARN`, and `BENCHMARK_ASG_NAME` to GitHub vars.
4. Resolve the CI/Pulumi ECS service conflict: either manage task-definition revisions in Pulumi via a config-driven SHA tag with `ignoreChanges`, or document a single source of truth.
5. Create the migration task definition in Pulumi and align the CI job.
6. Enable S3 versioning on the frontend bucket.
7. Wait for the Aurora snapshot to become available before running migrations.
8. Fix `createIam` so Task 6 typechecks standalone (defer DB secret policy to Task 10).
9. Fix the Image Builder cold-start risk.
10. Add post-migration and post-deploy smoke tests.
11. Fix CloudWatch alarm dimensions to use `alb.arnSuffix`.
12. Add TPS parsing and pass/fail logic to the benchmark workflow.

## Process Notes

- Re-review effort remained **high** due to infrastructure scope.
- All HARD-GATE findings were verified; two initial HARD-GATE candidates were downgraded to WARNING by the verifier.
- Sweep pass uncovered 4 additional cross-cutting issues, 3 of which were HARD-GATE.
