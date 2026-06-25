# Plan Review v3: Dopamint Arena AWS Infrastructure Implementation Plan

- **Date**: 2026-06-16
- **Plan**: `docs/superpowers/plans/2026-06-16-dopamint-aws-infra-implementation-plan.md` (revised v3)
- **Spec**: `docs/superpowers/specs/2026-06-16-dopamint-arena-aws-deployment-design.md`
- **Effort**: high
- **Verdict**: **NO-GO**

## Summary

v3 fixed most of the v2 blockers, but the third review still finds **8 confirmed HARD-GATE issues**. The remaining problems are concentrated in the backend deployment workflow (ordering of image-tag update vs. migration vs. service rollout), the ECS service `ignoreChanges` interaction with CI, frontend/backend contract sequencing, and a couple of deterministic AWS failures (static final snapshot, Golden AMI cold start). These are fixable, but the plan is not yet execution-ready without another revision.

## HARD-GATE Findings

### 1. Task 17 references benchmarkFleet before it is defined

- **Task ref**: Task 17
- **Category**: missing-prereq / branch-order
- **Issue**: `infra/src/index.ts` exports `benchmarkAsgName: benchmarkFleet.asgName` in Task 17, but `benchmarkFleet` is created in Task 20. TypeScript will fail.
- **Evidence**: Task 17 Step 2 exports `benchmarkAsgName: benchmarkFleet.asgName`; Task 20 Step 2 declares `const benchmarkFleet = createBenchmarkFleet(...)`.
- **Fix**: Move the GitHub env export task after Task 20, or split it: export non-benchmark vars after Task 16 and add `benchmarkAsgName` after Task 20.

### 2. Backend operational-contract integration tests are missing

- **Task ref**: Task 23 / Task 22
- **Category**: missing-integration
- **Issue**: The plan documents the backend contract but has no automated tests verifying SIGTERM drain, `/health/ready` returning 503 during shutdown, or clean DB/Redis pool shutdown.
- **Evidence**: Task 22 writes the contract; Task 23 only has typeof config tests and a placeholder Backend.test.ts description.
- **Fix**: Implement `Backend.test.ts` to assert task definition contract (port 8080, env vars, health paths, migration command). Add a CI integration test that runs the backend container and probes `/health/live`, `/health/ready`, and verifies graceful shutdown.

### 3. Post-migration schema verification is a placeholder

- **Task ref**: Task 27
- **Category**: data-validation-gap
- **Issue**: The migration job has a `Verify schema` step that only echoes a placeholder comment.
- **Evidence**: Task 27 Step 2: `# Connect via RDS Proxy and verify schema_migrations table/version` followed by `echo "Post-migration schema verification placeholder"`.
- **Fix**: Replace with a concrete check: run an ECS one-off task or psql via RDS Proxy to query `schema_migrations` and assert the expected version.

### 4. Backend container interface assumptions are hardcoded before contract validation

- **Task ref**: Tasks 11–14 / Task 22
- **Category**: interface-change / coordination-gap
- **Issue**: Port 8080, env vars, health paths, and `./scripts/migrate.sh` are baked into Pulumi before the backend contract task and without a backend-team sign-off gate.
- **Evidence**: Task 13 hardcodes `containerPort: 8080`, `DATABASE_URL`, `REDIS_PUBSUB_URL`, `REDIS_CACHE_URL`, `/health/live`, and `./scripts/migrate.sh`. Task 5 uses `/health/ready`. Task 22 documents these only afterward.
- **Fix**: Move Task 22 before Tasks 11–14; add an explicit acceptance criterion requiring backend-team sign-off on the contract before the Fargate task definitions are merged.

### 5. Benchmark ASG launch template uses base AMI while Golden AMI pipeline is separate

- **Task ref**: Tasks 18–21 / Task 28
- **Category**: race-condition
- **Issue**: The launch template is created with `imageId: baseAmi.id` and user data that expects the Golden AMI path. The refresh to the Golden AMI is documented as a manual one-time step, so scaling the ASG before that step will fail.
- **Evidence**: Task 20 launch template uses base AMI with user data `cd /opt/dopamint/repo/sui-tunnel-ts`. Task 21 says to update manually after first Golden AMI build. Task 28 scales the ASG immediately.
- **Fix**: Make the launch template depend on the first successful Image Builder output, or block ASG scaling until the Golden AMI is available and the launch template is refreshed.

### 6. ECS service ignoreChanges prevents Pulumi from rolling out new task definition

- **Task ref**: Task 14 / Task 27
- **Category**: coordination-gap
- **Issue**: The service has `ignoreChanges: ["taskDefinition"]`. The deploy-backend workflow runs `pulumi up` after setting the new SHA but never calls `aws ecs update-service --task-definition`, so the live service stays on the old revision.
- **Evidence**: Task 14: `{ ignoreChanges: ["taskDefinition"] }`. Task 27 Step 3: `pulumi up` then `aws ecs wait services-stable` with no update-service step.
- **Fix**: Remove `ignoreChanges` so Pulumi updates the service, or add an explicit `aws ecs update-service --task-definition <new-arn>` step after `pulumi up`.

### 7. Migration runs before the migration task definition is updated to the new SHA

- **Task ref**: Task 27 / Task 13
- **Category**: race-condition
- **Issue**: The migration job runs `aws ecs run-task` using the existing Pulumi-managed task definition (old image tag). The new SHA is only written to Pulumi config _after_ migration succeeds, so the migration runs against the previous image.
- **Evidence**: Task 27 Step 2 runs migration before Step 3 sets `pulumi config set dopamint:backend-image-tag ${{ github.sha }}` and runs `pulumi up`.
- **Fix**: Reorder: build/push image → set Pulumi config SHA → `pulumi up` to register new task definitions → run migration → update service.

### 8. Aurora final snapshot identifier is static

- **Task ref**: Task 8 / Task 29
- **Category**: coordination-gap
- **Issue**: `finalSnapshotIdentifier: ${name}-final` is static. After the first `pulumi destroy`, the name is consumed and subsequent destroys fail.
- **Evidence**: Task 8 sets `skipFinalSnapshot: false` with static `finalSnapshotIdentifier`.
- **Fix**: Append a timestamp or random suffix to `finalSnapshotIdentifier`, or make it configurable per stack.

## Refuted Finding

- **PRIVATE_SUBNET_IDS comma-separated format**: The AWS CLI `--network-configuration` shorthand accepts unquoted comma-separated lists, so the export/interpolation is valid. Not a blocker.

## WARNING Findings

1. Task 27 Step 3 'Verify schema' lacks concrete acceptance criteria.
2. Task 23 Backend.test.ts is a placeholder without code.
3. Task 21 Golden AMI initial build is vague and creates a duplicate pipeline.
4. Task 19 bundles multiple Image Builder resources in one step.
5. Task 16 CloudWatch alarms have SNS topic but no subscriptions.
6. Task 27+29: state inconsistency if service deploy fails after migration.
7. Task 14+29: rollback complexity due to `ignoreChanges`.
8. Task 26+29: frontend rollback broken because `aws s3 sync --delete` removes hashed assets.
9. Task 22+27+29: migrations are only reversible via full snapshot restore.
10. Task 6: GitHub OIDC deploy role has broad wildcard permissions.

## Required Rework

To reach GO, fix all 8 HARD-GATE findings. The most important:

1. Reorder tasks so GitHub env export happens after benchmark fleet creation.
2. Implement backend contract tests and require backend-team sign-off.
3. Replace migration schema placeholder with a real verification command.
4. Remove `ignoreChanges` on `taskDefinition` or add explicit `update-service`.
5. Reorder deploy-backend workflow: set SHA → `pulumi up` → migrate → update service.
6. Make Aurora final snapshot identifier unique.
7. Automate Golden AMI → launch template dependency.

## Process Notes

- Re-review effort remained **high**.
- All HARD-GATE findings verified; one sweep finding refuted.
- Sweep pass uncovered 4 additional cross-cutting issues, 3 of which were HARD-GATE.
