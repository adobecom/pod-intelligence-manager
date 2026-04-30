# PIM AWS Deployment Runbook (MVP)

One-page guide for deploying PIM to AWS using the `PimEc2Stack` in `packages/infra/`.
See the architecture rationale in the approved plan (Path A — EC2 + SQLite + ALB + CloudFront).

**How this fits the long-term design:** [ARCHITECTURE_CURRENT_VS_TARGET.md](ARCHITECTURE_CURRENT_VS_TARGET.md) contrasts Path A (what you deploy from this runbook) with the SPEC target (Lambda + DynamoDB).

## Prerequisites

- AWS CLI v2 (Klam-federated for Adobe accounts).
- Node 22 and pnpm 10.33.x installed locally.
- Docker for local image builds (CI builds in GitHub Actions).
- Target region: `us-west-2`.

## Naming and namespacing

The stack is namespaced per developer via the `owner` CDK context value (default: `rkhan`). All shared-name resources (bucket, ECR repo, log group, stack name) carry the prefix.

| Resource | Pattern | Example |
|---|---|---|
| Stack name | `PimEc2Stack-${owner}` | `PimEc2Stack-rkhan` |
| UI bucket | `pim-${owner}-ui-${account}` | `pim-rkhan-ui-947495650207` |
| Knowledge graph bucket | `pim-${owner}-kg-${account}` | `pim-rkhan-kg-947495650207` |
| Backups bucket | `pim-${owner}-backups-${account}` | `pim-rkhan-backups-947495650207` |
| ECR repo | `pim-${owner}-server` | `pim-rkhan-server` |
| CloudWatch log group | `/aws/ec2/pim-${owner}-server` | `/aws/ec2/pim-rkhan-server` |

Override with `npx cdk deploy -c owner=someone-else`. Every resource also carries tags: `Owner=$owner`, `Project=pim-demo`, `Environment=sandbox`, `ManagedBy=cdk`.

## Pre-cutover TODOs

1. **Account context** — confirm the target AWS account is one you have authority to deploy into. The stack creates roles, EC2, S3, CloudFront, and an ALB. In a shared account, namespacing protects against name collisions but cost still attributes to the shared account.
2. **CDK bootstrap** — usually a no-op in shared Adobe accounts (CDKToolkit already exists). Only run `cdk bootstrap` if `aws cloudformation describe-stacks --stack-name CDKToolkit` returns NOT FOUND.
3. **Bedrock model access** — the stack uses `AWS_BEARER_TOKEN_BEDROCK` from your `.env` (the same token that runs the server locally). Put it in SSM at `/pim/AWS_BEARER_TOKEN_BEDROCK` so the container picks it up via `fetch-secrets.sh`. No IAM-based Bedrock auth needed.
4. **ALB ingress hardening** — security group currently allows `0.0.0.0/0` on port 80 (CloudFront origins). For internal use this is acceptable. To harden, replace with the CloudFront managed prefix list (us-west-2: `pl-82a045eb`).
5. **GitHub OIDC role** — the deploy workflow uses `secrets.AWS_DEPLOY_ROLE_ARN`. Skip until you want CI deploys.

## First-time setup (local, one-time)

```sh
# 1. Auth via Klam — write creds to ~/.aws/credentials
aws configure set aws_access_key_id "<from Klam>"
aws configure set aws_secret_access_key "<from Klam>"
aws configure set aws_session_token "<from Klam>"
aws configure set region us-west-2

# 2. Verify
aws sts get-caller-identity

# 3. Export CDK env (account ID auto-detected)
export AWS_REGION=us-west-2
export CDK_DEFAULT_REGION=$AWS_REGION
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# 4. Install repo deps
pnpm install --frozen-lockfile

# 5. Bootstrap CDK only if needed (skip in adobeaws304 — already done)
aws cloudformation describe-stacks --stack-name CDKToolkit --region us-west-2 \
  || (cd packages/infra && npx cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION)
```

## First deploy

```sh
# From the monorepo root
pnpm build
cd packages/infra

# Synth first (read-only — generates the CFN template, makes one VPC lookup)
npx cdk synth PimEc2Stack-rkhan

# Real deploy (15–20 min; CloudFront is the slow part)
npx cdk deploy PimEc2Stack-rkhan --require-approval never --outputs-file outputs.json
```

Outputs include: `CloudFrontUrl`, `EcrRepoUri`, `UiBucketName`, `KnowledgeGraphBucketName`, `BackupsBucketName`, `AutoScalingGroupName`, `DistributionId`, `LogGroupName`, `AlbDnsName`.

After the stack comes up, the EC2 instance starts but has no image to run yet. **Push the initial image:**

```sh
# From monorepo root (with $AWS_REGION exported)
ECR=$(aws ecr describe-repositories --repository-names pim-rkhan-server --query 'repositories[0].repositoryUri' --output text)

aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin ${ECR%%/*}
docker build -f packages/server/Dockerfile -t $ECR:latest .
docker push $ECR:latest

# Trigger pull + start on the instance
ASG=$(aws cloudformation describe-stacks --stack-name PimEc2Stack-rkhan \
  --query 'Stacks[0].Outputs[?OutputKey==`AutoScalingGroupName`].OutputValue' --output text)
INSTANCE=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names $ASG \
  --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text)
aws ssm send-command --instance-ids $INSTANCE --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart pim-server"]'
```

Sync the UI:

```sh
UI=$(aws cloudformation describe-stacks --stack-name PimEc2Stack-rkhan \
  --query 'Stacks[0].Outputs[?OutputKey==`UiBucketName`].OutputValue' --output text)
DIST=$(aws cloudformation describe-stacks --stack-name PimEc2Stack-rkhan \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionId`].OutputValue' --output text)

aws s3 sync packages/ui/dist s3://$UI/ --delete
aws cloudfront create-invalidation --distribution-id $DIST --paths "/*"
```

Open the `CloudFrontUrl` from stack outputs in a browser.

## Populating secrets

Mirror your local `.env` into SSM Parameter Store under `/pim/*`. The container reads them at startup.

```sh
# The Bedrock bearer token is the must-have one
aws ssm put-parameter --name /pim/AWS_BEARER_TOKEN_BEDROCK --value "<from your .env>" --type SecureString

# Add others as needed (only what your local .env has)
aws ssm put-parameter --name /pim/SLACK_BOT_TOKEN --value "xoxb-…" --type SecureString
aws ssm put-parameter --name /pim/JIRA_TOKEN --value "…" --type SecureString
aws ssm put-parameter --name /pim/JIRA_EMAIL --value "…" --type String
aws ssm put-parameter --name /pim/JIRA_BASE_URL --value "…" --type String
aws ssm put-parameter --name /pim/CONFLUENCE_TOKEN --value "…" --type SecureString
aws ssm put-parameter --name /pim/CONFLUENCE_BASE_URL --value "…" --type String
aws ssm put-parameter --name /pim/GH_TOKEN --value "…" --type SecureString
```

The parameter's short name (after `/pim/`) becomes the env var name inside the container. After updates, restart:

```sh
aws ssm send-command --instance-ids $INSTANCE --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart pim-server"]'
```

## Routine deploys (via GitHub Actions)

Once `.github/workflows/deploy-mvp.yml` is enabled and `AWS_DEPLOY_ROLE_ARN` is set as a repo secret:

- Push to `main` → workflow builds, pushes to ECR, triggers SSM restart, syncs UI, invalidates CloudFront.
- Manual runs via the Actions tab (workflow_dispatch).

The workflow is hardcoded to `STACK_NAME=PimEc2Stack-rkhan`. Update if you fork the namespace.

## Verification smoke test

The active deployment is at **`https://d1ygncl0yqo6sv.cloudfront.net`** (stack `PimEc2Stack-rkhan`).

1. `curl https://d1ygncl0yqo6sv.cloudfront.net/api/health` → `{"status":"ok","db":{"connected":true,…}}`.
2. UI loads at `https://d1ygncl0yqo6sv.cloudfront.net/`.
3. Create a pod via UI; SSM into the instance and confirm: `sqlite3 /data/pim.db "SELECT * FROM pods"`.
4. Submit a context update; check CloudWatch Logs `/aws/ec2/pim-rkhan-server` for the Bedrock invocation line.
5. Browser devtools: `/ws?podId=<id>` WebSocket connects.
6. After 30 min: `aws s3 ls s3://pim-rkhan-kg-<account>/knowledge-graph/default/` should show `graph-latest.json`.
7. Top of the next hour: `aws s3 ls s3://pim-rkhan-backups-<account>/backups/` should show a dump.

## Rollback

```sh
aws ssm send-command --instance-ids $INSTANCE --document-name AWS-RunShellScript \
  --parameters 'commands=["docker pull '"$ECR"':<previous-sha> && docker tag '"$ECR"':<previous-sha> '"$ECR"':latest && systemctl restart pim-server"]'
```

ECR retains the last 10 image tags.

## Teardown

```sh
cd packages/infra
npx cdk destroy PimEc2Stack-rkhan
```

S3 buckets with `RemovalPolicy.RETAIN` (knowledge-graph, backups) survive — delete manually if you want them gone:

```sh
aws s3 rb s3://pim-rkhan-kg-<account> --force
aws s3 rb s3://pim-rkhan-backups-<account> --force
```

The ECR repo also retains its images. To remove:
```sh
aws ecr delete-repository --repository-name pim-rkhan-server --force
```
