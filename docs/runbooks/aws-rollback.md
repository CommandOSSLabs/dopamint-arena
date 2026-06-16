# AWS Rollback Runbook

## Triggers
- ALB 5xx rate > 1% for 2 minutes
- `/health/ready` failing on >50% of tasks
- Migration job exits non-zero
- CloudWatch alarm breach

## Frontend rollback
1. Find previous S3 version:
   ```bash
   aws s3api list-object-versions \
     --bucket $(pulumi stack output frontendBucket) \
     --prefix index.html
   ```
2. Restore the previous version with `aws s3api copy-object` and invalidate the CloudFront distribution.

## Backend rollback
1. Set the previous image tag in Pulumi (replace `<git-sha>` with the SHA of the last known-good backend image):
   ```bash
   cd infra
   pulumi config set dopamint:backend-image-tag <git-sha> --stack dev
   pulumi up -y
   ```
2. Wait for stability:
   ```bash
   aws ecs wait services-stable \
     --cluster $(pulumi stack output clusterName) \
     --services $(pulumi stack output backendServiceName)
   ```

## Database rollback
If migration caused data corruption:
1. Restore the cluster from a pre-migration snapshot (replace `<pre-migration-snapshot>` with the actual snapshot identifier):
   ```bash
   aws rds restore-db-cluster-from-snapshot \
     --db-cluster-identifier dopamint-dev-aurora-rollback \
     --snapshot-identifier <pre-migration-snapshot> \
     --engine aurora-postgresql
   ```
2. Update the RDS Proxy target to the new cluster.
3. Roll the backend back to a compatible image.
