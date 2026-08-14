# Manual deploy guide for coding agents

**Status:** current handoff for the `PimEc2Stack` deployment

Use this guide only when the user explicitly asks to deploy. Repository changes alone do not
authorize an external deployment.

## Preferred path

Use the canonical GitHub Actions workflow:

```sh
gh workflow run deploy-mvp.yml
gh run list --workflow deploy-mvp.yml --limit 5
```

If the change is merging to `main`, the push trigger runs the same workflow automatically. The
workflow is safer than an ad-hoc restart because it:

- builds and tags the exact Git commit;
- resolves and deploys an immutable ECR digest;
- carries the terminal `MemoryCutoverComplete` output forward;
- verifies temporary host ECR push access is off;
- replaces the systemd unit with the digest-pinned image;
- waits for local health; and
- publishes/invalidate the UI.

Do not substitute `docker push :latest` plus `systemctl restart`. Restarting a cached mutable tag can
serve the wrong image and bypasses the fence checks.

## Before triggering a deploy

1. Confirm the user authorized the target environment and exact change.
2. Confirm the working tree/commit that will be deployed; CI deploys the selected Git ref, not
   uncommitted local changes.
3. Run checks proportional to the change, including `pnpm docs:check` for docs/script changes and
   `pnpm --filter @pim/infra test` for deployment changes.
4. Confirm the workflow's `STACK_NAME`, region, and OIDC role belong to the intended environment.
5. Read the current stack outputs for `MemoryCutoverComplete` and `ServerImagePushAllowed`.
6. Confirm a recent verified backup exists before schema, authority, or stateful changes.

## Watch and report

Use `gh run watch <run-id>` or the Actions UI. A successful handoff records:

- Git commit and workflow run URL;
- immutable ECR digest;
- stack and region;
- preserved memory-cutover state;
- final `ServerImagePushAllowed=false`;
- health result and server `started_at`;
- UI sync/CloudFront invalidation; and
- any warnings or skipped verification.

## Verification

Resolve the URL from the stack output:

```sh
CF_URL="$(aws cloudformation describe-stacks \
  --stack-name PimEc2Stack-rkhan \
  --region us-west-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontUrl`].OutputValue' \
  --output text)"
curl -fsS "$CF_URL/api/health"
```

Check that:

- database connectivity is healthy;
- Memory v2 availability matches the release expectation;
- the running unit uses the workflow's digest;
- API/MCP authorization errors remain JSON and are not rewritten to the SPA;
- the UI loads; and
- the deployment did not change the terminal memory fence.

## If CI cannot deploy

Stop and report the concrete blocker when the OIDC role, branch protection, AWS session, or target
approval is missing. Do not silently broaden IAM or enable the host ECR push gate.

The stack has a temporary `allowServerImagePush` context for an explicitly reviewed scoped-host
build. Using it is a separate privileged operation: it must be raised through CDK, used only for the
named image, and lowered in the immediate digest-pinning deploy. The final stack output must be
`ServerImagePushAllowed=false`.

## Configuration-only restart

An SSM parameter update still requires explicit deployment authorization. Restart the one systemd
service so `fetch-secrets.sh` reloads `/pim/*`, then verify health and `started_at`. Do not restart
during an offline cutover, restore, or retention/erasure operation.

## Rollback

Use a previously reviewed immutable image digest and preserve the current terminal cutover state.
Before deploying it, verify that the old image supports the current database migrations and
canonical authority. Never lower `MemoryCutoverComplete`, serve a pre-cutover database, or delete
audit rows to make an older image start.

## Related docs

- [DEPLOY.md](./DEPLOY.md) — architecture, first-time setup, invariants, and rollback
- [BACKUP_RESTORE.md](./BACKUP_RESTORE.md) — state protection and recovery verification
- [MEMORY_OPERATIONS.md](./MEMORY_OPERATIONS.md) — canonical-memory incident handling
- `.github/workflows/deploy-mvp.yml` — executable deployment definition
