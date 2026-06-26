# Setup millionstps.io Domain on AWS with Cloudflare DNS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing AWS/Pulumi infrastructure to serve Dopamint Arena publicly on `millionstps.io` using Cloudflare as the authoritative DNS provider.

**Architecture:** Cloudflare owns DNS for `millionstps.io`. AWS ACM issues a wildcard TLS certificate in `us-east-1`, validated by CNAME records in Cloudflare. Pulumi uses that certificate for CloudFront and the ALB. Cloudflare CNAME records route `dev.millionstps.io` and `api.dev.millionstps.io` (plus staging and production equivalents) to CloudFront and the ALB respectively.

**Tech Stack:** Pulumi TypeScript, AWS ACM/CloudFront/ALB/ECS, Cloudflare DNS, GitHub Actions.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `infra/src/config.ts` | Reads `dopamint:certificate-arn` from Pulumi config |
| `infra/src/components/Dns.ts` | Returns existing cert ARN if provided, otherwise creates cert via Route 53 |
| `infra/src/index.ts` | Passes `certificateArn` from config into `createDns` |
| `infra/Pulumi.dev.yaml` | Dev stack config: domain `dev.millionstps.io`, cert ARN, empty Route 53 zone |
| `infra/Pulumi.staging.yaml` | Staging stack config: domain `staging.millionstps.io`, cert ARN, empty Route 53 zone |
| `infra/Pulumi.production.yaml` | Production stack config: domain `millionstps.io`, cert ARN, empty Route 53 zone |

---

### Task 1: Add `certificateArn` config option

**Files:**
- Modify: `infra/src/config.ts`

- [ ] **Step 1: Add field to `InfraConfig` interface**

```ts
export interface InfraConfig {
  environment: string;
  domain: string;
  route53ZoneId?: string;
  certificateArn?: string; // existing ACM certificate ARN (Cloudflare DNS scenario)
  dbInstanceClass: string;
  // ... rest unchanged
}
```

- [ ] **Step 2: Read the config value in `getConfig`**

```ts
export function getConfig(): InfraConfig {
  return {
    environment: config.require("environment"),
    domain: config.require("domain"),
    route53ZoneId: config.get("route53-zone-id") || undefined,
    certificateArn: config.get("certificate-arn") || undefined,
    // ... rest unchanged
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `cd infra && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add infra/src/config.ts
git commit -m "feat(infra): add certificate-arn config option"
```

---

### Task 2: Make `Dns.ts` accept an existing certificate

**Files:**
- Modify: `infra/src/components/Dns.ts`

- [ ] **Step 1: Update function signature**

```ts
export function createDns(
  name: string,
  args: { domain: string; route53ZoneId?: string; certificateArn?: string },
): DnsOutputs {
```

- [ ] **Step 2: Return existing cert early when provided**

Insert at the top of `createDns`:

```ts
  if (args.certificateArn) {
    return {
      certificateArn: pulumi.output(args.certificateArn),
      domain: args.domain,
    };
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd infra && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add infra/src/components/Dns.ts
git commit -m "feat(infra): support existing ACM certificate in Dns component"
```

---

### Task 3: Pass certificate ARN from config to `createDns`

**Files:**
- Modify: `infra/src/index.ts`

- [ ] **Step 1: Add `certificateArn` to the `createDns` call**

```ts
const dns = createDns(`dopamint-${cfg.environment}`, {
  domain: cfg.domain,
  route53ZoneId: cfg.route53ZoneId,
  certificateArn: cfg.certificateArn,
});
```

- [ ] **Step 2: Typecheck**

Run: `cd infra && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add infra/src/index.ts
git commit -m "feat(infra): pass certificate-arn config to Dns component"
```

---

### Task 4: Request ACM certificate and validate via Cloudflare

**Manual AWS/Cloudflare steps:**

- [ ] **Step 1: Request certificate in ACM**

1. Open AWS Console → Certificate Manager.
2. Ensure region is **us-east-1**.
3. Request a public certificate with these domains:
   - `millionstps.io`
   - `*.millionstps.io`
4. Choose DNS validation.
5. Copy the CNAME name/value pairs from the certificate details.

- [ ] **Step 2: Add validation CNAMEs in Cloudflare**

Go to Cloudflare Dashboard → `millionstps.io` → DNS → Records.

Add two CNAME records with **DNS-only** proxy status:

| Type | Name | Target |
|------|------|--------|
| CNAME | `<acm-validation-name>` | `<acm-validation-value>` |
| CNAME | `<acm-validation-name-2>` | `<acm-validation-value-2>` |

- [ ] **Step 3: Wait for certificate status = Issued**

Refresh ACM until status shows **Issued**.

- [ ] **Step 4: Copy the certificate ARN**

It looks like:

```
arn:aws:acm:us-east-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

---

### Task 5: Update Pulumi stack configs

**Files:**
- Modify: `infra/Pulumi.dev.yaml`
- Modify: `infra/Pulumi.staging.yaml`
- Modify: `infra/Pulumi.production.yaml`

- [ ] **Step 1: Update dev config**

```yaml
config:
  aws:region: us-east-1
  dopamint:environment: dev
  dopamint:domain: dev.millionstps.io
  dopamint:certificate-arn: arn:aws:acm:us-east-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  dopamint:route53-zone-id: ""
  dopamint:db-instance-class: db.r6g.large
  dopamint:db-min-capacity: "0.5"
  dopamint:db-max-capacity: "4"
  dopamint:db-serverless: "true"
  dopamint:cache-node-type: cache.r6g.4xlarge
  dopamint:benchmark-instance-type: c7i.48xlarge
  dopamint:benchmark-min-size: "2"
  dopamint:benchmark-max-size: "2"
  dopamint:settler-key:
    secure: AAABAJh+ACo2yp6b8S9CVYe/VuZyCoRpJyWjME2aJxsKOITpdDIPVug3sqII0+sGj6dA6tzjElGaCMModIVyrvvH0OOd6HNQqDB7+g==
```

- [ ] **Step 2: Update staging config**

```yaml
config:
  aws:region: us-east-1
  dopamint:environment: staging
  dopamint:domain: staging.millionstps.io
  dopamint:certificate-arn: arn:aws:acm:us-east-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  dopamint:route53-zone-id: ""
  dopamint:db-instance-class: db.r6g.2xlarge
  dopamint:db-serverless: "false"
  dopamint:cache-node-type: cache.r6g.large
  dopamint:benchmark-instance-type: c7i.48xlarge
  dopamint:benchmark-min-size: 0
  dopamint:benchmark-max-size: 2
```

- [ ] **Step 3: Update production config**

```yaml
config:
  aws:region: us-east-1
  dopamint:environment: production
  dopamint:domain: millionstps.io
  dopamint:certificate-arn: arn:aws:acm:us-east-1:123456789012:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  dopamint:route53-zone-id: ""
  dopamint:db-instance-class: db.r6g.2xlarge
  dopamint:db-serverless: "false"
  dopamint:cache-node-type: cache.r6g.large
  dopamint:benchmark-instance-type: c7i.48xlarge
  dopamint:benchmark-min-size: 0
  dopamint:benchmark-max-size: 4
```

> Replace the certificate ARN with the real ARN from Task 4.

- [ ] **Step 4: Commit**

```bash
git add infra/Pulumi.dev.yaml infra/Pulumi.staging.yaml infra/Pulumi.production.yaml
git commit -m "feat(infra): configure millionstps.io domains and ACM certificate"
```

---

### Task 6: Deploy infrastructure for dev

- [ ] **Step 1: Select dev stack and run pulumi up**

```bash
cd infra
pnpm install
pulumi stack select dev
pulumi up
```

Expected: Pulumi creates CloudFront distribution and ALB with the provided certificate. No Route 53 records are created.

- [ ] **Step 2: Capture outputs**

```bash
pulumi stack output frontendDomain
pulumi stack output albDnsName
pulumi stack output backendUrl
```

Example values:

```
frontendDomain: abcdefgh123456.cloudfront.net
albDnsName: dopamint-dev-alb-1234567890.us-east-1.elb.amazonaws.com
backendUrl: https://api.dev.millionstps.io
```

---

### Task 7: Add Cloudflare DNS records

- [ ] **Step 1: Add dev records in Cloudflare**

Go to Cloudflare Dashboard → `millionstps.io` → DNS → Records.

| Type | Name | Target | Proxy status |
|------|------|--------|--------------|
| CNAME | `dev` | `<dev-cloudfront-domain>` | DNS only |
| CNAME | `api.dev` | `<dev-alb-dns-name>` | DNS only |

- [ ] **Step 2: Repeat for staging and production**

For production apex domain, use CNAME flattening:

| Type | Name | Target | Proxy status |
|------|------|--------|--------------|
| CNAME | `@` | `<prod-cloudfront-domain>` | DNS only |
| CNAME | `api` | `<prod-alb-dns-name>` | DNS only |

> Keep `api.*` DNS-only. Do not enable Cloudflare proxying on API records unless you also configure Cloudflare-origin certificates.

---

### Task 8: Allow-list auth origins

- [ ] **Step 1: Google OAuth Console**

Add to Authorized JavaScript origins for the client ID used by `VITE_GOOGLE_CLIENT_ID`:

- `https://dev.millionstps.io`
- `https://staging.millionstps.io`
- `https://millionstps.io`

- [ ] **Step 2: Enoki Portal**

Add to allowed origins for the Enoki app used by `VITE_ENOKI_API_KEY`:

- `https://dev.millionstps.io`
- `https://staging.millionstps.io`
- `https://millionstps.io`

---

### Task 9: Deploy backend

- [ ] **Step 1: Trigger GitHub Actions workflow**

Run `.github/workflows/deploy-backend.yml` for environment `dev`.

Or run locally:

```bash
cd backend/tunnel-manager
docker build --platform linux/arm64 -t <ecr-url>:$(git rev-parse --short HEAD) .
docker push <ecr-url>:$(git rev-parse --short HEAD)

cd infra
pulumi config set dopamint:backend-image-tag $(git rev-parse --short HEAD)
pulumi up
```

- [ ] **Step 2: Verify health endpoints**

```bash
curl -f https://api.dev.millionstps.io/health/live
curl -f https://api.dev.millionstps.io/health/ready
```

Expected: HTTP 200 for both.

---

### Task 10: Deploy frontend

- [ ] **Step 1: Trigger GitHub Actions workflow**

Run `.github/workflows/deploy-frontend.yml` for environment `dev`.

No code change is needed; the workflow already sets `VITE_BACKEND_URL=""` for same-origin proxying through CloudFront.

- [ ] **Step 2: Verify frontend loads**

```bash
curl -f https://dev.millionstps.io
```

Expected: HTTP 200 with the SPA HTML.

---

### Task 11: End-to-end verification

- [ ] **Step 1: Verify HTTPS and DNS**

```bash
curl -f https://dev.millionstps.io
curl -f https://api.dev.millionstps.io/health/live
curl -f https://api.dev.millionstps.io/health/ready
```

- [ ] **Step 2: Verify same-origin API proxy**

```bash
curl -f https://dev.millionstps.io/v1/stats/live
```

Expected: SSE stream headers (HTTP 200, `content-type: text/event-stream`).

- [ ] **Step 3: Verify WebSocket**

Open browser dev tools on `https://dev.millionstps.io` and connect to:

```
wss://dev.millionstps.io/v1/mp
```

Expected: WebSocket handshake succeeds.

- [ ] **Step 4: Verify auth**

Sign in with Google / zkLogin in the browser. Expected: authentication succeeds without origin errors.

---

## Self-Review

**Spec coverage:**
- Cloudflare authoritative DNS: covered by manual Cloudflare steps.
- AWS ACM wildcard cert in us-east-1: covered in Task 4.
- Pulumi uses existing cert: Tasks 1–3.
- Per-environment domains: Task 5.
- Public DNS records: Task 7.
- Auth allow-listing: Task 8.
- Backend/frontend deploy and verify: Tasks 9–11.

**Placeholder scan:**
- Certificate ARN is shown as a placeholder in Task 5 because the real value comes from Task 4. This is intentional; the engineer fills it in after creating the cert.
- No other placeholders.

**Type consistency:**
- `certificateArn` is `string | undefined` in config and `string | undefined` in `createDns` args. Output wrapping is consistent with existing `pulumi.output()` usage.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-25-setup-millionstps-domain.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session, batch by batch with checkpoints.

**Which approach?**
