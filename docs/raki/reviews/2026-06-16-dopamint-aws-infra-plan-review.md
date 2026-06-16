# Plan Review: Dopamint Arena AWS Infrastructure Implementation Plan

- **Date**: 2026-06-16
- **Plan**: `docs/superpowers/plans/2026-06-16-dopamint-aws-infra-implementation-plan.md`
- **Spec**: `docs/superpowers/specs/2026-06-16-dopamint-arena-aws-deployment-design.md`
- **Effort**: high
- **Verdict**: **NO-GO**

## Summary

The plan covers the right components and maps to the approved design, but it is not execution-ready. There are **13 unresolved HARD-GATE findings** — including deployment-blocking bugs (HTTPS listener without certificate, RDS Proxy target miswired, ECS task role missing Secrets Manager access, Redis TLS/cluster-mode mismatch), ordering failures (backend deployed before migrations), and process gaps (no test section, no rollback strategy, oversized tasks). It must be revised before implementation begins.

## HARD-GATE Findings

Ranked by execution-blocking impact.

### 1. ALB HTTPS listener has no certificate; Route 53/ACM missing
- **Task ref**: Task 3 / Task 4 / Task 10
- **Category**: interface-change
- **Issue**: The ALB HTTPS listener is created without a `certificateArn`, CloudFront uses the default `*.cloudfront.net` certificate, and `dopamint:domain` is never used. AWS will reject the HTTPS listener.
- **Evidence**: `infra/src/resources/alb.ts` creates `new aws.lb.Listener(..., { port: 443, protocol: "HTTPS", ... })` with no `certificateArn`. `infra/src/components/Frontend.ts` sets `viewerCertificate: { cloudfrontDefaultCertificate: true }`.
- **Fix**: Add `infra/src/components/Dns.ts` to request an ACM certificate in `us-east-1` (required for CloudFront), create Route 53 alias records, pass `certificateArn` to the ALB listener, and configure CloudFront aliases + `acmCertificateArn`.

### 2. ECS task execution role cannot read the DB secret
- **Task ref**: Task 7
- **Category**: missing-contract-test
- **Issue**: The task definition injects `DATABASE_PASSWORD` from Secrets Manager, but the task execution role only has `AmazonECSTaskExecutionRolePolicy`, which does not grant `secretsmanager:GetSecretValue`. Fargate tasks will fail to start.
- **Evidence**: `managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"]` plus `secrets: [{ name: "DATABASE_PASSWORD", valueFrom: args.dbSecretArn }]`.
- **Fix**: Attach a least-privilege policy to the task execution role allowing `secretsmanager:GetSecretValue` (and `kms:Decrypt` if a CMK is used) on the DB secret ARN.

### 3. RDS Proxy target is wired to cluster resource ID instead of cluster identifier
- **Task ref**: Task 5 / Task 7
- **Category**: interface-change
- **Issue**: `aws.rds.ProxyTarget.dbClusterIdentifier` expects the cluster identifier, but the plan passes `cluster.resourceId`. Proxy target registration will fail.
- **Evidence**: `Database.ts` returns `clusterResourceId: cluster.resourceId`; `DatabaseProxy.ts` passes it as `dbClusterIdentifier`.
- **Fix**: Return and pass `cluster.id` (or `cluster.clusterIdentifier`) instead.

### 4. Redis TLS and cluster mode are enabled but backend connects with plain `redis://`
- **Task ref**: Task 6 / Task 7
- **Category**: interface-change
- **Issue**: `transitEncryptionEnabled: true` requires `rediss://`, and sharded pub/sub / cluster-mode cache require cluster-aware endpoints. The backend URLs are plain `redis://` and non-clustered.
- **Evidence**: `Cache.ts` sets `transitEncryptionEnabled: true` but no `clusterMode`. `Backend.ts` sets `REDIS_PUBSUB_URL: redis://${pubSubHost}:6379` and `REDIS_CACHE_URL: redis://${cacheHost}:6379`.
- **Fix**: Enable `clusterMode` / `numNodeGroups` for the pub/sub group, use the cluster configuration endpoint, and switch URLs to `rediss://`. Add a smoke test for `SSUBSCRIBE`/`SPUBLISH`.

### 5. ALB/container health checks use `/health` but the backend contract requires `/health/live` and `/health/ready`
- **Task ref**: Task 3 / Task 7
- **Category**: interface-change
- **Issue**: The spec mandates split health endpoints. If the backend team implements only the spec, the ALB will mark all tasks unhealthy.
- **Evidence**: `alb.ts` uses `path: "/health"`. `Backend.ts` health check uses `curl -f http://localhost:8080/health`. Spec requires `/health/live` and `/health/ready`.
- **Fix**: Change ALB target group to `/health/ready` and container health check to `/health/live`, or coordinate with the backend team to expose a legacy `/health` route.

### 6. Backend service is updated before database migrations run
- **Task ref**: Task 10
- **Category**: unsafe-order / race-condition
- **Issue**: The `deploy-backend` job pushes the image and calls `aws ecs update-service` with no migration step, violating the spec's required ordering.
- **Evidence**: Spec CI/CD: "Run database migrations: Execute migrations as a one-off ECS Task/Job before updating the backend service." The workflow has no migration job.
- **Fix**: Add a `run-migrations` job that runs the migration as a one-off Fargate task and exits 0 before `deploy-backend` updates the service.

### 7. No rollback strategy
- **Task ref**: general
- **Category**: no-rollback
- **Issue**: The only rollback reference is a runbook snippet that re-deploys the current task definition (`force-new-deployment`). There are no triggers, no known-good revision pinning, no DB rollback, and no rehearsed steps.
- **Evidence**: Task 11 runbook: `aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment`.
- **Fix**: Add a Rollback task with triggers (5xx rate, health-check failures, migration failure), ECS rollback to previous task-definition revision / SHA-tagged image, Pulumi rollback via previous git ref, frontend rollback via versioned S3 artifact, and DB restore from pre-migration snapshot.

### 8. Database migrations have no snapshot/rollback safety
- **Task ref**: Task 10
- **Category**: irreversible-migration
- **Issue**: Migrations run as a one-off task with no pre-migration snapshot, no idempotency requirement, and no rollback script.
- **Evidence**: Spec requires migrations before service update, but the plan does not implement a migration step or any safety measure.
- **Fix**: Before migrations, create an Aurora snapshot `pre-migration-<git-sha>-<timestamp>`. Use idempotent migrations and keep rollback scripts. Run smoke tests from a canary task before updating the service.

### 9. Image Builder launch template references a non-existent first image
- **Task ref**: Task 9
- **Category**: external-dep
- **Issue**: `aws.imagebuilder.getImageOutput` queries the most recent image from a newly created pipeline, which has not produced an image yet. First `pulumi up` will fail.
- **Evidence**: Task 9: `const latestImage = aws.imagebuilder.getImageOutput({ imagePipelineArn: pipeline.arn });` then `imageId: latestImage.id`.
- **Fix**: Bootstrap with a base AMI and trigger the first image build separately, or use a conditional fallback to the base AMI when no pipeline image exists.

### 10. No testing task or CI test job
- **Task ref**: general
- **Category**: no-test-section
- **Issue**: The spec mandates "Typecheck & test (`pnpm typecheck`, `pnpm test`, `sui move test`)". The plan has no `test` script, no testing task, and the CI workflow omits tests.
- **Evidence**: `infra/package.json` has no `test` script. Task 10 workflow has `changes`, `deploy-infra`, `deploy-frontend`, `deploy-backend` only.
- **Fix**: Add a Testing task: `test` script in `infra/package.json` (vitest/node:test), CI test job, and include `sui move test` if Move changes are detected.

### 11. Task 10 (CI/CD) is one oversized checkbox
- **Task ref**: Task 10 Step 1
- **Category**: oversized
- **Issue**: A single step writes a 130-line multi-job workflow with OIDC, path filtering, Pulumi, frontend build, backend Docker build, and ECS update. Far exceeds the 30-minute decomposition threshold.
- **Evidence**: `- [ ] **Step 1: Create `.github/workflows/deploy.yml`**` followed by the full workflow.
- **Fix**: Decompose into: provision OIDC role/GitHub env vars, path-filter job, Pulumi infra job, frontend deploy job, backend build/push job, migration job, and workflow dry-run.

### 12. Task 9 (Golden AMI) is one oversized checkbox
- **Task ref**: Task 9 Step 1
- **Category**: oversized
- **Issue**: One step adds IAM role, instance profile, component, recipe, distribution config, infrastructure config, pipeline, and launch-template change.
- **Evidence**: Task 9 Step 1 code block adds ~90 lines of Image Builder resources plus the launch-template modification.
- **Fix**: Decompose into: IAM/instance profile, component/recipe, distribution/infrastructure config, pipeline, launch-template update.

### 13. Task 7 (Backend component) is one oversized checkbox
- **Task ref**: Task 7 Step 1
- **Category**: oversized
- **Issue**: One step creates ECR repo, ECS cluster, two IAM roles, CloudWatch log group, task definition, and ECS service/ALB attachment.
- **Evidence**: Task 7 Step 1 code block is ~140 lines covering all these resources.
- **Fix**: Decompose into: ECR repo + lifecycle policy, IAM roles, ECS cluster/log group, Fargate task definition, ECS service with ALB attachment.

## WARNING Findings

1. **No IAM/OIDC resources or GitHub env var sync** (Task 10) — workflow references `${{ vars.* }}` and a deploy role, but no task creates `infra/src/resources/iam.ts` or syncs Pulumi outputs to GitHub vars.
2. **Frontend, Database, and Cache tasks could run in parallel** (Tasks 4/5/6) — they share only network/security-group inputs and are independent.
3. **CI workflow acceptance criteria are too weak** (Task 10) — only YAML parse check; missing `actionlint`, OIDC role-assumption test, and migration/AMI stage validation.
4. **No automated 1M TPS performance verification** (Task 11) — the fleet is provisioned but no automated benchmark with pass/fail threshold is scheduled.
5. **Missing CloudWatch alarms** (Task 7/general) — spec requires 5xx rate, ALB p99, Aurora CPU alarms; only a LogGroup is created.
6. **Aurora backup retention not configured** (Task 5) — `skipFinalSnapshot: true` and no `backupRetentionPeriod` contradict spec "automated backups".
7. **Partial-migration state inconsistency risk** (Task 10) — if service update fails after migration succeeds, previous backend may be incompatible with new schema.
8. **ECS task definition uses `:latest` while CI pushes SHA** (Task 7/10) — no task-definition revision pinning; rollout is non-deterministic and rollback to SHA is impossible.
9. **Backend operational contracts not communicated/verified** (Task 7/whole plan) — SIGTERM drain, split health checks, env-var contract need a coordination task or contract test.

## Required Rework

Before this plan can receive a GO verdict, the author must:

1. Fix all 13 HARD-GATE issues above.
2. Add a dedicated Testing task and CI test job.
3. Add a Rollback task with triggers, revert steps, and DB snapshot/restore.
4. Decompose the three oversized tasks into sub-≤30-minute steps.
5. Add acceptance criteria for every CI job (lint, dry-run, canary, alarm checks).
6. Add CloudWatch alarms and an automated 1M TPS benchmark verification task.
7. Add IAM/OIDC and GitHub environment variable provisioning.

## Process Notes

- Effort escalated to **high** because this is infrastructure, production-facing, multi-system, and includes database/Redis/ECS changes.
- All HARD-GATE findings were verified by `plan-verifier` and returned **CONFIRMED**.
- Sweep pass uncovered 4 additional HARD-GATE integration gaps not caught by focused finders.
