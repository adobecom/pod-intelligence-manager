# PIM backup and restore

PIM uses two complementary recovery layers. The default policy is designed to
scale with project-search growth without paying to retain thousands of duplicate
copies of rebuildable embeddings.

| Layer | Contents | Schedule (UTC) | Retention |
|---|---|---|---|
| S3 hourly core dump | Authoritative SQLite tables; excludes `project_search_*` | Hourly at minute 0 | 3 days |
| S3 daily core dump | Same verified archive as that hour | 00:00 daily | 35 days |
| S3 weekly core dump | Same verified archive as that hour | 00:00 Sunday | 91 days; Standard-IA after 30 days |
| AWS Backup hourly | Complete `/data` EBS volume, including the exact search index | Hourly at minute 15 | 2 days |
| AWS Backup daily | Complete `/data` EBS volume | 02:30 daily | 30 days |
| AWS Backup weekly | Complete `/data` EBS volume | 03:30 Sunday | 84 days |

EBS recovery points are incremental after the first snapshot: AWS stores changed
blocks, while every recovery point still behaves like a full-volume restore. The
portable S3 dumps are much smaller because search documents, chunks, FTS rows,
graph-index rows, and embeddings can be reproduced from evidence and context.

## Where to change the policy

- S3 retention and AWS Backup schedules: `packages/infra/lib/pim-ec2-stack.ts`
- Portable dump contents and tier selection: `packages/server/scripts/backup.sh`
- Empty-volume restore and validation: `packages/server/scripts/restore-db.sh`
- Post-restore search reconstruction: `packages/server/src/services/project-search-recovery.ts`

These are deployment settings, so no new SSM parameter is required. GitHub repo
names and Jira project keys remain per-project resource configuration; only the
credentials belong in SSM.

## What happens on deploy

A normal image or CDK deploy does **not** alter `/data/pim.db` and does not delete
the existing project-search index. The stack tags only the secondary `/data` EBS
volume with `PimBackup=pim-<owner>-data`; the tag-based AWS Backup selection then
protects current and replacement volumes automatically.

The new S3 lifecycle prefixes apply to backups created after the new image runs.
Legacy `backups/pim-*.sql.gz` objects keep their prior 90-day policy.

## Automatic logical restore

On an empty replacement volume, `restore-db.sh`:

1. Selects the newest `.sql.gz` object recursively under `backups/`, unless
   `PIM_RESTORE_KEY` pins an exact object.
2. Downloads it into a staging area and verifies the automatic `.sha256` sidecar.
3. Streams decompressed SQL into a sibling SQLite file (no uncompressed SQL copy
   in `/tmp`), then runs `PRAGMA integrity_check` and verifies at least one org.
4. Atomically publishes the validated database.
5. For a `pim-core-*` backup, writes a search-rebuild marker.

At server startup, after org knowledge graphs are loaded, the marker triggers a
local rebuild for every project from `project_evidence_items`, project context,
linked pod updates, local Git data when available, and scoped org-KG nodes. The
marker is removed only after every project succeeds. Connector APIs and Bedrock
are not called during this recovery pass, so lexical and graph search return
without an external-service burst. The normal six-hour refresh incrementally
restores embeddings for configured projects.

If one project cannot be rebuilt, the server keeps the core PIM available, logs
the failed project, and retains the marker so the next process start retries.

## Full-volume recovery

Use an AWS Backup recovery point when the exact search index/embeddings are needed
or when SQLite/S3 logical restore is not appropriate. Restore the recovery point
as an EBS volume, keep the application stopped, attach the recovered volume as the
single `/data` disk, and then start one server instance. Never put two independent
SQLite volumes behind the ALB; PIM remains a single-writer deployment.

## Verification after deployment

Confirm the data-volume tag:

```sh
aws ec2 describe-volumes --region us-west-2 \
  --filters Name=tag:PimBackup,Values=pim-rkhan-data \
  --query 'Volumes[].{VolumeId:VolumeId,State:State,SizeGiB:Size}'
```

Confirm core dumps and their checksum sidecars after the next hour:

```sh
aws s3 ls s3://pim-rkhan-backups-<account>/backups/hourly/ --recursive
```

Confirm successful recovery points after minute 15:

```sh
aws backup list-backup-jobs --region us-west-2 \
  --by-state COMPLETED --max-results 20
```

For a controlled migration, create a manifest containing only the authoritative
tables so it matches the core backup before and after search reconstruction:

```sh
docker exec pim-server \
  /app/packages/server/scripts/capture-manifest.sh --core /data/pim.db
```

Periodically perform a throwaway restore test. Retention is useful only when both
the logical import and the volume-recovery procedure have been exercised.
