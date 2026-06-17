# AWS Rollback Runbook

Roll back a failed deployment.

## Before you begin

1. Page the on-call and open an incident if users are impacted.
2. Confirm the trigger and affected scope (frontend, backend, database, or all).
3. Ensure your shell is configured for the target AWS account and region:
   ```bash
   export AWS_PROFILE=commandoss-dev
   export AWS_REGION=us-east-1
   cd infra
   pulumi stack select dev
   ```

## Triggers

- ALB `HTTPCode_Target_5XX_Count` > 1% of total requests for 2 minutes
- More than 50% of backend tasks fail `/health/ready`
- Backend migration task exits non-zero
- Any critical CloudWatch alarm (ALB 5xx, target response time, database connections, etc.) is in `ALARM` state

## Frontend rollback

1. Find the previous S3 version of `index.html`:
   ```bash
   aws s3api list-object-versions \
     --bucket $(pulumi stack output frontendBucket) \
     --prefix index.html
   ```
2. Copy that version over the current object (replace `<previous-version-id>`):
   ```bash
   aws s3api copy-object \
     --bucket $(pulumi stack output frontendBucket) \
     --copy-source $(pulumi stack output frontendBucket)/index.html?versionId=<previous-version-id> \
     --key index.html
   ```
3. Invalidate the CloudFront distribution:
   ```bash
   aws cloudfront create-invalidation \
     --distribution-id $(pulumi stack output cloudfrontId) \
     --paths "/*"
   ```
4. Verify the rollback:
   ```bash
   curl -fsSI https://$(pulumi stack output frontendDomain)
   ```

## Backend rollback

1. Set the previous known-good image tag in Pulumi (replace `<git-sha>`):
   ```bash
   cd infra
   pulumi stack select dev
   pulumi config set dopamint:backend-image-tag <git-sha>
   pulumi up -y
   ```
2. Wait for the ECS service to stabilize:
   ```bash
   aws ecs wait services-stable \
     --cluster $(pulumi stack output clusterName) \
     --services $(pulumi stack output backendServiceName)
   ```
3. Verify health:
   ```bash
   curl -fsS $(pulumi stack output backendUrl)/health/ready
   ```

## Database rollback

Use this only if a migration caused data corruption and you have a pre-migration snapshot.

1. Restore the cluster from the snapshot (replace `<pre-migration-snapshot>`):
   ```bash
   aws rds restore-db-cluster-from-snapshot \
     --db-cluster-identifier dopamint-dev-aurora-rollback \
     --snapshot-identifier <pre-migration-snapshot> \
     --engine aurora-postgresql \
     --db-subnet-group-name $(pulumi stack output dbSubnetGroupName) \
     --vpc-security-group-ids $(pulumi stack output dbSecurityGroupId)
   ```
2. Create a writer instance for the restored cluster:
   ```bash
   aws rds create-db-instance \
     --db-cluster-identifier dopamint-dev-aurora-rollback \
     --db-instance-identifier dopamint-dev-aurora-rollback-writer \
     --db-instance-class db.serverless \
     --engine aurora-postgresql
   ```
3. Wait for the instance to become available:
   ```bash
   aws rds wait db-instance-available \
     --db-instance-identifier dopamint-dev-aurora-rollback-writer
   ```
4. Update the RDS Proxy target to point at the restored cluster. Proxy target groups allow only one tracked cluster at a time, so deregister the old cluster first, then register the restored cluster:
   ```bash
   OLD_CLUSTER=$(aws rds describe-db-proxy-targets \
     --db-proxy-name $(pulumi stack output dbProxyName) \
     --target-group-name default \
     --query 'Targets[?Type==`TRACKED_CLUSTER`].RdsResourceId | [0]' --output text)
   aws rds deregister-db-proxy-targets \
     --db-proxy-name $(pulumi stack output dbProxyName) \
     --target-group-name default \
     --db-cluster-identifiers "$OLD_CLUSTER"
   aws rds register-db-proxy-targets \
     --db-proxy-name $(pulumi stack output dbProxyName) \
     --target-group-name default \
     --db-cluster-identifiers dopamint-dev-aurora-rollback
   ```
5. Roll the backend back to a version compatible with the pre-migration schema (see [Backend rollback](#backend-rollback)).
6. Verify the backend health endpoint and that `/health/ready` returns `200 OK`.

## Post-rollback verification

- [ ] ALB target health shows all targets healthy
- [ ] `curl -fsS $(pulumi stack output backendUrl)/health/ready` returns `200 OK`
- [ ] Frontend URL returns `200 OK`
- [ ] CloudWatch 5xx count is trending down
- [ ] Incident commander notified and rollback window monitored for 15 minutes
