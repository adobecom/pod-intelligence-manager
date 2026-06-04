# Manual deploy guide (for coding agents)

This document is for **Cursor / Claude / other agents** that need to redeploy the hosted PIM sandbox when a human says “deploy my changes” or after merging to `main`. It captures operational lessons from repeated manual deploys; the full CDK runbook remains in [DEPLOY.md](./DEPLOY.md).

## When to use this

| Situation | Action |
|-----------|--------|
| User changed server/UI code and wants it live | Follow **Full redeploy** below |
| User only changed UI | Skip Docker; run **UI only** |
| User only changed SSM secrets | **Restart server** only (no build) |
| First-time stack / infra change | Use [DEPLOY.md](./DEPLOY.md) (`cdk deploy`), not this doc |
| Push to `main` should auto-deploy | Prefer GitHub Actions — see **CI status** |

## Active environment (rkhan sandbox)

| Item | Value |
|------|--------|
| Public URL | `https://d1ygncl0yqo6sv.cloudfront.net` |
| Region | `us-west-2` |
| CloudFormation stack | `PimEc2Stack-rkhan` |
| Account | resolved via `aws sts get-caller-identity` |

Resolve dynamic IDs from stack outputs — do not hardcode instance IDs unless SSM lookup fails.

```bash
export AWS_REGION=us-west-2
export STACK_NAME=PimEc2Stack-rkhan

ECR=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`EcrRepoUri`].OutputValue' --output text)

UI_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UiBucketName`].OutputValue' --output text)

DIST_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)

ASG=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`AutoScalingGroupName`].OutputValue' --output text)

INSTANCE=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" --region "$AWS_REGION" \
  --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId | [0]' --output text)
```

## Prerequisites (agent checklist)

1. **Repo root** — all commands below assume monorepo root (`ai-council/`).
2. **AWS credentials** — Klam-federated session on the target account:
   ```bash
   aws sts get-caller-identity --region us-west-2
   ```
   If you see `SignatureDoesNotMatch` or “Could not load credentials”, the session token expired — ask the human to refresh Klam and retry.
3. **Docker** — required for server image builds. On macOS, Docker Desktop is often **not** on `PATH`:
   ```bash
   DOCKER="${DOCKER:-/Applications/Docker.app/Contents/Resources/bin/docker}"
   "$DOCKER" version
   ```
4. **pnpm** — UI build: `pnpm --filter @pim/ui build` (needs `pnpm install` if deps missing).
5. **Shell permissions** — agent terminal needs `network` / `all` for AWS, Docker, and ECR push.

## Full redeploy (server + UI)

Typical user request: *“I made changes, redeploy.”* Deploy **both** server and UI unless the user scoped to one.

### 1. Record what you are shipping

```bash
git rev-parse --short HEAD
git log -1 --oneline
git status --short   # warn if large uncommitted diff vs what user expects
```

Tag images with a traceable name (ECR also gets `:latest`):

```bash
SHA=$(git rev-parse --short HEAD)
TAG="manual-$(date -u +%Y%m%dT%H%M%SZ)-${SHA}"
```

### 2. Build and push server image

```bash
DOCKER="${DOCKER:-/Applications/Docker.app/Contents/Resources/bin/docker}"

# ECR + INSTANCE from "Active environment" block above
aws ecr get-login-password --region "$AWS_REGION" | \
  "$DOCKER" login --username AWS --password-stdin "${ECR%%/*}"

"$DOCKER" build -f packages/server/Dockerfile \
  -t "${ECR}:${TAG}" -t "${ECR}:latest" .

"$DOCKER" push "${ECR}:${TAG}"
"$DOCKER" push "${ECR}:latest"
```

Note the pushed digest from the push output for the deploy summary.

### 3. Pull on EC2 and restart (critical)

**`systemctl restart pim-server` alone is not enough.** The instance caches the local `:latest` image; restart reuses the old digest until `docker pull`.

```bash
CMD_ID=$(aws ssm send-command --region "$AWS_REGION" \
  --instance-ids "$INSTANCE" \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[
    \"aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR%%/*}\",
    \"docker pull ${ECR}:latest\",
    \"systemctl restart pim-server\",
    \"sleep 3\",
    \"systemctl is-active pim-server\"
  ]" \
  --query 'Command.CommandId' --output text)

# Poll until Success or Failed (5s interval, ~60s timeout)
aws ssm get-command-invocation --region "$AWS_REGION" \
  --command-id "$CMD_ID" --instance-id "$INSTANCE" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
```

Expect `active` and a pull line like `Status: Downloaded newer image`.

### 4. Build and publish UI

```bash
pnpm --filter @pim/ui build

aws s3 sync packages/ui/dist "s3://${UI_BUCKET}/" --delete --region "$AWS_REGION"

aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*"
```

Tell the user to hard-refresh the browser; invalidation takes a few minutes.

### 5. Verify

```bash
curl -sS "https://d1ygncl0yqo6sv.cloudfront.net/api/health"
```

Healthy response shape:

```json
{"status":"ok","started_at":"...","db":{"connected":true,"active_pods":N}}
```

Check `started_at` — it should be **after** your restart. If behavior still looks stale, compare running image on the box:

```bash
aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker images '"${ECR}"' --format \"{{.Tag}} {{.ID}} {{.CreatedSince}}\" | head -5"]'
```

## UI only

```bash
pnpm --filter @pim/ui build
aws s3 sync packages/ui/dist "s3://${UI_BUCKET}/" --delete --region "$AWS_REGION"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*"
```

## Server restart only (secrets / config)

After SSM parameter updates under `/pim/*`:

```bash
aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart pim-server"]'
```

If env vars are baked into a **new image**, use the full redeploy path instead.

## Pitfalls (read before debugging “deploy didn’t work”)

### zsh and `$ECR:latest`

In zsh, `$ECR:latest` is parsed as `$ECR` + `:latest` as a modifier — the tag breaks. Always use **`${ECR}:latest`**.

### Restart ≠ pull

Symptom: ECR shows a new digest but API behavior unchanged; health `started_at` updates but logic is old.  
Fix: `docker pull ${ECR}:latest` on the instance, then `systemctl restart pim-server`.

### Docker not on PATH (macOS agents)

Use `DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker` or export it once per session.

### Expired AWS session

`SignatureDoesNotMatch` on ECR/S3/SSM → refresh Klam credentials; do not retry blindly ten times.

### Uncommitted local changes

Deploy builds from the **working tree** (`docker build` copies the repo). If `git status` is dirty, the image matches the workspace, not necessarily `main`. Call this out in the summary.

### GitHub Actions CI deploy

Workflow: `.github/workflows/deploy-mvp.yml` (push to `main`, `workflow_dispatch`).

As of manual-deploy practice, CI may fail with **OIDC / `AWS_DEPLOY_ROLE_ARN` not configured** (`Could not load credentials from any providers`). Until that secret exists, **manual deploy is the supported path** for this sandbox.

### API testing against hosted KG

Org-scoped routes often need:

```bash
curl -sS -H "X-Pim-Org: emc-sandbox" "https://d1ygncl0yqo6sv.cloudfront.net/api/..."
```

The knowledge graph on this host is EMC-seeded; PIM-specific queries may return unrelated nodes — that is data, not a failed deploy.

## Rollback

ECR retains recent tags. Redeploy a previous tag:

```bash
PREV_TAG=manual-20260603T233840Z-c9dde2b   # example

aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[
    \"docker pull ${ECR}:${PREV_TAG}\",
    \"docker tag ${ECR}:${PREV_TAG} ${ECR}:latest\",
    \"systemctl restart pim-server\"
  ]"
```

Or push an old digest as `:latest` from a machine that still has the image.

## One-shot script (copy-paste)

Adjust only if stack name or region changes. Run from monorepo root after `aws sts get-caller-identity` succeeds.

```bash
set -euo pipefail
export AWS_REGION=us-west-2
export STACK_NAME=PimEc2Stack-rkhan
DOCKER="${DOCKER:-/Applications/Docker.app/Contents/Resources/bin/docker}"

SHA=$(git rev-parse --short HEAD)
TAG="manual-$(date -u +%Y%m%dT%H%M%SZ)-${SHA}"

ECR=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`EcrRepoUri`].OutputValue' --output text)
UI_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`UiBucketName`].OutputValue' --output text)
DIST_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)
ASG=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`AutoScalingGroupName`].OutputValue' --output text)
INSTANCE=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" --region "$AWS_REGION" \
  --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId | [0]' --output text)

echo "Deploying ${TAG} to instance ${INSTANCE}"

aws ecr get-login-password --region "$AWS_REGION" | \
  "$DOCKER" login --username AWS --password-stdin "${ECR%%/*}"
"$DOCKER" build -f packages/server/Dockerfile -t "${ECR}:${TAG}" -t "${ECR}:latest" .
"$DOCKER" push "${ECR}:${TAG}"
"$DOCKER" push "${ECR}:latest"

CMD_ID=$(aws ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR%%/*}\",\"docker pull ${ECR}:latest\",\"systemctl restart pim-server\",\"sleep 3\",\"systemctl is-active pim-server\"]" \
  --query Command.CommandId --output text)

for _ in $(seq 1 12); do
  STATUS=$(aws ssm get-command-invocation --region "$AWS_REGION" \
    --command-id "$CMD_ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || true)
  [[ "$STATUS" == "Success" || "$STATUS" == "Failed" ]] && break
  sleep 5
done
aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$CMD_ID" \
  --instance-id "$INSTANCE" --query '[Status,StandardOutputContent]' --output text

pnpm --filter @pim/ui build
aws s3 sync packages/ui/dist "s3://${UI_BUCKET}/" --delete --region "$AWS_REGION"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*"

curl -sS "https://d1ygncl0yqo6sv.cloudfront.net/api/health"
echo ""
echo "Done: ${TAG}"
```

## Agent response template

After a successful deploy, report briefly:

- **Commit**: `<sha>` — `<subject>`
- **Image tag**: `manual-...-<sha>` (and digest if available)
- **Health**: `started_at`, `active_pods`
- **UI**: S3 sync + CloudFront invalidation id
- **Caveats**: dirty tree, CI still broken, invalidation in progress

## Related docs

- [DEPLOY.md](./DEPLOY.md) — CDK first deploy, secrets, teardown, naming
- [DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md) — pre/post deploy checklist
- [POD_AGENT_PROTOCOL.md](./POD_AGENT_PROTOCOL.md) — PIM context/reporting for pod work (not required to run deploy)
- `.github/workflows/deploy-mvp.yml` — automated deploy definition
