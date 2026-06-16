# AWS Deploy Runbook

## Prerequisites
- AWS CLI authenticated
- Pulumi CLI logged in
- pnpm installed

## First-time setup
1. Create the Pulumi stack:
   ```bash
   cd infra
   pnpm install
   pulumi stack init dev
   pulumi up -y
   ```
2. Export GitHub environment variables:
   ```bash
   pulumi stack output githubEnv --json | jq -r 'to_entries[] | "\(.key)=\(.value)"'
   ```
   Set these in the GitHub environment `dev`.

## Deploy from local
```bash
cd infra
pulumi stack select dev
pulumi up -y
```

## Run 1M TPS benchmark
```bash
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name $(pulumi stack output benchmarkAsgName) \
  --desired-capacity 2
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-name $(pulumi stack output benchmarkAsgName) \
  --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)
aws ssm start-session --target "$INSTANCE_ID"
cd /opt/dopamint/repo/sui-tunnel-ts
numactl --interleave=all UV_THREADPOOL_SIZE=128 \
  node --import tsx src/bench/cli.ts \
  --tunnels 20000 --updates-per-tunnel 50 --agents 2000 --workers 95
```

## Teardown
```bash
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name $(pulumi stack output benchmarkAsgName) \
  --desired-capacity 0
pulumi destroy -y
```
