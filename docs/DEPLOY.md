# PIM AWS deployment runbook

**Status:** current MVP deployment as of 2026-08-13

PIM deploys through `PimEc2Stack` in `packages/infra`. The stack is intentionally a single-writer
EC2/SQLite deployment, not the retained Lambda/DynamoDB target stack.

## Deployed shape

- CloudFront serves the S3-hosted UI and forwards API, MCP, WebSocket, and tunnel traffic.
- An ALB accepts origin traffic from the CloudFront managed prefix list and targets one in-service
  EC2 instance.
- The server runs as a digest-pinned Docker image under systemd.
- `/data` is a dedicated EBS volume containing SQLite and legacy graph files.
- S3 stores portable logical backups and versioned graph objects; AWS Backup protects the full
  volume.
- ECR stores server images, SSM Parameter Store supplies runtime configuration/secrets, and
  CloudWatch/SNS provide logs, metrics, alarms, and backup-failure notifications.

The Auto Scaling Group has a single active writer. This stack is not multi-AZ or zero-downtime.

## Prerequisites

- Node 24 and pnpm 10.33.x
- AWS CLI v2 and an authorized federated session for the target account
- Docker when building an image outside CI
- CDK bootstrap in the target account/region
- GitHub OIDC role stored as `AWS_DEPLOY_ROLE_ARN` for automated deploys

The repository defaults to owner `rkhan` and region `us-west-2`. Override the namespace with
`-c owner=<owner>`; do not reuse another owner's stack unintentionally.

## Resource outputs

`PimEc2Stack-<owner>` publishes:

- `CloudFrontUrl`, `DistributionId`, and `UiBucketName`;
- `AlbDnsName`, `AutoScalingGroupName`, and `VpcId`;
- `EcrRepoUri` and `LogGroupName`;
- `KnowledgeGraphBucketName` and `BackupsBucketName`;
- `DataBackupVaultName`, `DataBackupPlanId`, and `OperationsAlertTopicArn`;
- `MemoryCutoverComplete`; and
- `ServerImagePushAllowed`.

Resolve dynamic values from these outputs. Do not hardcode instance IDs, bucket names, or image
digests in scripts.

## First-time infrastructure setup

Verify the account before any write:

```sh
aws sts get-caller-identity
export AWS_REGION=us-west-2
export CDK_DEFAULT_REGION="$AWS_REGION"
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
```

Install and validate the checkout:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @pim/infra test
```

Bootstrap CDK only when `CDKToolkit` is absent:

```sh
aws cloudformation describe-stacks \
  --stack-name CDKToolkit \
  --region "$AWS_REGION"
```

Then synthesize and review the exact stack:

```sh
cd packages/infra
npx cdk synth PimEc2Stack-rkhan -c owner=rkhan
```

The first infrastructure deploy can create ECR before an image exists; the host will not become
healthy until an authorized publisher pushes a server image and the stack is redeployed with its
immutable digest. Normal deploys are handled by GitHub Actions below.

## Runtime configuration in SSM

The container loads parameters recursively from `/pim/`; each short parameter name becomes an
environment variable. Put credentials in `SecureString` parameters and non-secret configuration in
`String` parameters.

At minimum, review:

- `AUTH_MODE` and the corresponding IMS server/CLI values for authenticated deployments;
- `PIM_SERVICE_TOKEN_PEPPER` before issuing production service tokens;
- Bedrock credentials/models when LLM behavior is enabled;
- connector credentials and project visibility assertions;
- `MEMORY_ACTIVATION_REPOSITORIES` and evidence hosts;
- Memory worker/reverification settings; and
- notification and operations-alert configuration.

Do not upload the local `.env` wholesale. Add only reviewed settings and restart the one server
after changes. The complete configuration reference is `.env.example`.

## Routine deployment

`.github/workflows/deploy-mvp.yml` is the canonical deployment workflow. A push to `main` or an
authorized `workflow_dispatch` run:

1. installs with Node 24 and builds the monorepo;
2. assumes the scoped AWS OIDC role;
3. reads the current stack's ECR URI and terminal memory-cutover output;
4. builds and pushes SHA plus `latest` image tags;
5. resolves the immutable ECR digest;
6. deploys only the scoped stack with that digest and carries
   `MemoryCutoverComplete` forward unchanged;
7. rejects a stack that leaves `ServerImagePushAllowed=true`;
8. installs a digest-pinned systemd unit on each in-service instance and waits for local health;
9. syncs the UI; and
10. invalidates CloudFront.

Manual invocation:

```sh
gh workflow run deploy-mvp.yml
gh run list --workflow deploy-mvp.yml --limit 5
```

Do not reproduce only the `docker push :latest` and `systemctl restart` pieces. A correct release
pins the digest, preserves the memory fence, updates the unit, and verifies health.

## Memory authority fence

`MemoryCutoverComplete` is terminal operational state:

- before the reviewed offline cutover, leave it `false`;
- after the cutover commits canonical authority, raise it once with
  `-c memoryCutoverComplete=true` and a reviewed image digest; and
- every later deploy must read and carry the existing output forward.

When true, the stack mounts the legacy graph read-only, removes graph-bucket write access, and sets
`PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY=1`. Lowering the flag or serving a pre-cutover database can
reactivate forbidden writers and is not a rollback strategy.

Follow [MEMORY_OFFLINE_CUTOVER.md](./MEMORY_OFFLINE_CUTOVER.md) for the one-time transition.

## Temporary host ECR push gate

The EC2 role has ECR pull-only access by default. `-c allowServerImagePush=true` exists only for a
reviewed, temporary scoped-host image build when CI credentials are unavailable. If it is raised,
the next digest-pinning deploy must lower it immediately. CI fails when the final stack output is
not `false`.

Prefer CI or another scoped publisher over enabling this gate.

## Verification

Resolve the public URL from the stack rather than relying on a copied hostname:

```sh
CF_URL="$(aws cloudformation describe-stacks \
  --stack-name PimEc2Stack-rkhan \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue' \
  --output text)"
curl -fsS "$CF_URL/api/health"
```

Verify:

1. health reports a connected database and expected Memory v2 availability;
2. the running systemd unit references the reviewed immutable ECR digest;
3. `MemoryCutoverComplete` matches the database authority state;
4. `ServerImagePushAllowed` is `false`;
5. the UI loads and WebSocket/API routes are not rewritten to `index.html`;
6. CloudWatch receives container logs and operational metrics;
7. the next logical backup publishes an archive plus checksum; and
8. AWS Backup records a successful data-volume recovery point.

See [BACKUP_RESTORE.md](./BACKUP_RESTORE.md) for backup and recovery verification.

## Rollback

Application rollback means deploying a previously reviewed immutable image digest while preserving
the current database and terminal memory-fence output. It does not mean retagging an unknown local
image, lowering the cutover flag, or restoring a pre-cutover database into service.

Before rollback, confirm the older image understands the current migration and authority state. If
it does not, stop and fix forward. Database recovery must use a verified post-cutover canonical
backup and the recovery runbook.

## Teardown

`cdk destroy` is destructive and does not define data-retention approval. The graph and backup
buckets plus ECR repository are retained by policy. Inventory and preserve every required recovery
artifact before an authorized teardown, then remove retained resources separately under the owning
team's data-retention process.
