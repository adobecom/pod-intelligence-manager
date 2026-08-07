# PIM memory offline cutover

This runbook moves the legacy SQLite candidates and JSON knowledge graphs into the
canonical memory tables. PIM is offline for the entire operation. The cutover does
not delete or rewrite any legacy row or graph file.

The safety rule is simple: do not start PIM until the import report accounts for
every source item and the database authority is `canonical`.

## Preconditions

- Disable prompt exposure and stop the PIM API, workers, scheduled graph jobs, and
  backup job. Confirm no process is writing the database or graph directories.
- While PIM remains stopped, deploy the reviewed authority-fence build and its
  read-only legacy-bucket IAM policy. The build must contain migration
  `009-memory-offline-legacy-cutover`, the runtime write guards, and the persistent
  SQL barriers. Do not let the deployment start PIM yet. Pin that build's immutable
  image digest as the rollback floor.
- The EC2 unit is restart-enabled. On a legacy database the new startup gate fails
  closed; explicitly stop and runtime-mask the unit after deployment:

  ```sh
  systemctl stop pim-server.service
  systemctl mask --runtime pim-server.service
  systemctl is-active pim-server.service
  docker ps --filter name=pim-server
  ```

  Require `inactive` and no running `pim-server` container before checkpointing.
  Do not inventory while the unit is restart-looping.
- Record the exact database path and every graph root. Do not rely on a default
  working directory.
- Never deploy an image below the pinned authority-fence image digest after this
  cutover.

The commands below use `/data/pim.db`, `/data/knowledge-graph`, and
`/data/pim-cutover-YYYYMMDDTHHMMSSZ` as explicit examples. Replace all three with
the reviewed production paths.

## 1. Checkpoint and validate SQLite

With every PIM process stopped, apply the numbered schema migrations without
starting the service:

```sh
pnpm --filter @pim/server migrate-legacy-memory -- prepare \
  --db /data/pim.db
```

The command must report all eleven migrations and `legacy` authority at revision
zero. Then checkpoint the WAL:

```sh
sqlite3 /data/pim.db 'PRAGMA wal_checkpoint(TRUNCATE);'
```

The first field must be `0`, and `/data/pim.db-wal` must be absent or empty. Then
verify the source database:

```sh
sqlite3 -readonly /data/pim.db 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
```

The output must contain `ok` followed by no foreign-key rows.

## 2. Create verified recovery copies

Create a dedicated, empty cutover directory on durable storage. Capture the
deterministic non-search DB/org/KG manifest and a transactionally consistent SQLite
copy while every writer remains stopped:

```sh
pnpm --filter @pim/server capture-transfer-manifest -- create \
  --db /data/pim.db \
  --graph-root primary=/data/knowledge-graph \
  --recovery-set-id pre-cutover-YYYYMMDDTHHMMSSZ \
  --output /data/pim-cutover-YYYYMMDDTHHMMSSZ/pre-cutover.transfer-manifest.json
sqlite3 /data/pim.db \
  ".backup '/data/pim-cutover-YYYYMMDDTHHMMSSZ/pim.pre-cutover.db'"
sqlite3 -readonly /data/pim-cutover-YYYYMMDDTHHMMSSZ/pim.pre-cutover.db \
  'PRAGMA integrity_check; PRAGMA foreign_key_check;'
sha256sum /data/pim-cutover-YYYYMMDDTHHMMSSZ/pim.pre-cutover.db \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/pim.pre-cutover.db.sha256
```

The manifest tool rejects symlinks rather than following them. Archive every graph
root separately with the root contents at the archive root so the fail-closed restore
tool can stage and verify it directly:

```sh
tar -C /data/knowledge-graph -czf \
  /data/pim-cutover-YYYYMMDDTHHMMSSZ/knowledge-graph.pre-cutover.tar.gz \
  .
sha256sum \
  /data/pim-cutover-YYYYMMDDTHHMMSSZ/knowledge-graph.pre-cutover.tar.gz \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/knowledge-graph.pre-cutover.tar.gz.sha256
```

Repeat the archive and checksum commands for every additional graph root. Also run
the normal portable S3 backup in [BACKUP_RESTORE.md](./BACKUP_RESTORE.md) and perform
its throwaway restore check when production policy requires an off-host recovery
copy. Do not proceed if any checksum, integrity check, restore, or manifest check
fails.

If `KG_S3_BUCKET` is configured, preserve and inventory that authority too. Record
the versioned object inventory, sync every current object under the exact prefix to
an explicit local root, and archive it before changing IAM:

```sh
aws s3api list-object-versions \
  --bucket PIM_KG_BUCKET \
  --prefix knowledge-graph/ \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/kg-s3-object-versions.json
aws s3 sync \
  s3://PIM_KG_BUCKET/knowledge-graph/ \
  /data/pim-cutover-YYYYMMDDTHHMMSSZ/kg-s3-current/
sha256sum /data/pim-cutover-YYYYMMDDTHHMMSSZ/kg-s3-object-versions.json \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/kg-s3-object-versions.json.sha256
```

Archive the synced root and pass it as another `--graph-root` during inventory,
planning, and apply. Resolve every S3-only or divergent node exactly like a local
layout. Do not revoke writes while a remote-only layout remains outside the
inventory.

### 2.1 Prepare reviewed repository bindings

If a bounded legacy collection has an explicit operator review, prepare its exact
project repository bindings before generating the final inventory. The policy must
name the organization, project, canonical GitHub repository ID, immutable provider
repository ID, display slug, disposition, and assertions. This step is additive,
is permitted only under unfrozen `legacy` authority, and runs in one transaction:

```sh
pnpm --filter @pim/server prepare-reviewed-memory-repositories -- \
  --db /data/pim.db \
  --policy /data/pim-cutover-YYYYMMDDTHHMMSSZ/reviewed-policy.json \
  --output /data/pim-cutover-YYYYMMDDTHHMMSSZ/repository-preparation.json
```

Checkpoint and integrity-check the database again after this step. The inventory,
resolution template, plan, and apply must all use this new stopped-state database
digest. Do not edit repository bindings after inventory.

## 3. Inventory all legacy authorities

Inventory the stopped, checkpointed database and all graph layouts:

```sh
pnpm --filter @pim/server inventory-legacy-graphs -- \
  --db /data/pim.db \
  --graph-root /data/knowledge-graph \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/inventory.json
```

Add one `--graph-root` for each archived root. Keep `inventory.json` with the
recovery copies. Review every snapshot issue, divergent layout, unresolved pointer,
and orphan reference before constructing the resolution manifest.

## 4. Resolve and dry-run

Generate a fail-closed `pim.memory-legacy-resolution-manifest.v1` template. It
contains every source key and payload digest and quarantines everything by default:

```sh
pnpm --filter @pim/server migrate-legacy-memory -- template \
  --db /data/pim.db \
  --inventory /data/pim-cutover-YYYYMMDDTHHMMSSZ/inventory.json \
  --graph-root /data/knowledge-graph \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/resolutions-template.json
```

Add the same complete graph-root list used for inventory. Keep this
default-quarantine template unchanged; write the reviewed result to
`resolutions.json`, either manually or with the reviewed collection builder below.
The reviewed result is bound to the exact source database digest in
`inventory.json`. Every source key must retain one explicit disposition:

- `active`: only a resolvable graph node with complete codebase or harness
  applicability, provenance, evidence, and a payload accepted by the canonical
  structural validator. Harness records and anti-patterns also require mapped
  authorized-review evidence;
- `pending_validation`: structurally mapped but not yet trusted for activation;
- `quarantined`: incomplete, ambiguous, orphaned, conflicting, invalid/unmapped
  organization-plane, rejected, or promoted-without-a-node data. A valid mapped
  organization-plane item is forced to `pending_validation`/`pending_review`.

Organization memory remains manual-only. Never use `active` merely to make the
coverage count pass.

A reviewed collection may use the deterministic resolution builder instead of
hand-editing hundreds of entries. This is appropriate only when an authorized
operator has actually reviewed and certified the whole bounded collection. An
active collection must explicitly assert all three facts:

- `curated`: the operator certifies every selected node is curated;
- `legacy_snapshot_provenance`: the reviewed immutable snapshot is the accepted
  provenance for this one-time import; and
- `codebase_scope`: every selected node belongs to the named project and routed
  repository.

The builder binds that review independently to every source key, source payload
digest, snapshot digest, organization, project, and repository. It supplies an
`authorized_review` evidence handle for the exact payload. A changed graph byte,
wrong repository, missing assertion, or copied review envelope fails closed. This
does not create a reusable bulk-promotion API and does not relax normal evidence
rules for memories created after cutover.

```sh
pnpm --filter @pim/server build-reviewed-memory-resolutions -- \
  --template /data/pim-cutover-YYYYMMDDTHHMMSSZ/resolutions-template.json \
  --inventory /data/pim-cutover-YYYYMMDDTHHMMSSZ/inventory.json \
  --policy /data/pim-cutover-YYYYMMDDTHHMMSSZ/reviewed-policy.json \
  --output /data/pim-cutover-YYYYMMDDTHHMMSSZ/resolutions.json
```

Collections that are retained but not certified must use
`pending_validation`; they remain durable and non-serving until revalidated by the
normal canonical path. Collections outside the approved scope and legacy SQL
candidate/evidence authorities must remain explicitly quarantined in the manifest.

Imported `pending_validation` items are durable, visible parked candidates with a
`legacy_reingestion_required` blocker. They are deliberately not queued for
automatic validation: re-submit them through the normal typed receipt/evidence path
before activation so legacy evidence cannot bypass canonical trust gates.

Run the deterministic plan without writing:

```sh
pnpm --filter @pim/server migrate-legacy-memory -- plan \
  --db /data/pim.db \
  --inventory /data/pim-cutover-YYYYMMDDTHHMMSSZ/inventory.json \
  --resolutions /data/pim-cutover-YYYYMMDDTHHMMSSZ/resolutions.json \
  --graph-root /data/knowledge-graph \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/plan.json
```

The plan must report complete source coverage, no invalid active mapping, and exact
source hashes. Same-content entries may be marked `deduplicated`; a same-ID,
different-content collision must be quarantined. Fix the manifest and re-run until
the plan is clean.

## 5. Apply once and reconcile

Apply the reviewed plan while PIM remains stopped:

```sh
pnpm --filter @pim/server migrate-legacy-memory -- apply \
  --db /data/pim.db \
  --inventory /data/pim-cutover-YYYYMMDDTHHMMSSZ/inventory.json \
  --resolutions /data/pim-cutover-YYYYMMDDTHHMMSSZ/resolutions.json \
  --graph-root /data/knowledge-graph \
  --actor offline-cutover-operator \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/import-report.json
```

The importer verifies the inventory and source payload digests again. In one
`BEGIN IMMEDIATE` transaction it freezes legacy writes, writes the immutable import
ledger and canonical records, reconciles every source item, and makes canonical
memory terminal authority. Any failure rolls the whole transaction back.

Re-run reconciliation using the `import_run_id` from the report:

```sh
pnpm --filter @pim/server migrate-legacy-memory -- reconcile \
  --db /data/pim.db \
  --import-run-id IMPORT_RUN_ID \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/reconciliation.json
```

Run the offline dual-read comparison against the same immutable import ledger:

```sh
pnpm --filter @pim/server migrate-legacy-memory -- compare \
  --db /data/pim.db \
  --import-run-id IMPORT_RUN_ID \
  > /data/pim-cutover-YYYYMMDDTHHMMSSZ/dual-read-comparison.json
```

The comparison combines legacy projections and canonical records by scoped
canonical claim key, selects canonical lifecycle state, and returns each logical
memory once. `returned_count + deduplicated_count +
suppressed_inactive_legacy_count` must equal `combined_projection_count`.

Replaying the same apply input must return the existing run rather than create new
records. Different input for an already imported source key must fail closed.

## 6. Acceptance gates

Run these checks before starting PIM:

```sh
sqlite3 -readonly /data/pim.db 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
sqlite3 -readonly /data/pim.db \
  "SELECT revision, to_authority, legacy_writes_frozen FROM memory_authority_transitions ORDER BY revision;"
sqlite3 -readonly /data/pim.db \
  "SELECT source_item_count, imported_count, pending_count, quarantined_count, deduplicated_count FROM memory_legacy_import_runs ORDER BY created_at DESC LIMIT 1;"
sqlite3 -readonly /data/pim.db \
  "SELECT disposition, count(*) FROM memory_legacy_import_items GROUP BY disposition ORDER BY disposition;"
```

Required results:

- integrity is `ok` and foreign-key output is empty;
- the final authority is `canonical` with `legacy_writes_frozen = 1`;
- imported + pending + quarantined + deduplicated equals source item count;
- the reconciliation report independently matches the immutable ledger and
  canonical record versions;
- the dual-read report coverage equation holds and its `logical_memory_key` values
  are unique;
- canonical search tests return each representative codebase and harness record;
- imported historical active records retain valid current-dimension embeddings
  when their stored embedding-text hash matches, but remain
  `prompt_eligible = 0` initially;
- `GET /api/v1/memory/records/:record_id/history` returns the immutable versions,
  lifecycle reasons, and predecessor/successor link for a representative record;
- organization records remain non-active/manual; and
- prompt exposure remains disabled until the normal release gates pass.

Capture a new deterministic manifest and post-cutover database backup after all
gates pass. Bind the final logical backup, every local/S3 KG archive, S3 version inventory,
completed stopped-state snapshot, reviewed image digest, authority state, and alert
subscription into the single final recovery-set manifest described in
[DEPLOY.md](./DEPLOY.md). Compute and retain an independent SHA-256 of the manifest
file itself.

Restore-test the final DB, every KG archive, and snapshot clone, then require the verifier
to return no mismatch:

```sh
pnpm --filter @pim/server capture-transfer-manifest -- verify \
  --db /restore/pim.db \
  --graph-root primary=/restore/knowledge-graph \
  --manifest /data/pim-cutover-YYYYMMDDTHHMMSSZ/final-transfer-manifest.json
```

## 7. Permanently retire legacy writers

Keep all legacy graph roots and the pre-cutover database copy as read-only recovery
artifacts. Mount the graph archive/roots read-only for the PIM service identity;
verify that identity cannot create a sentinel file. The infrastructure half of the
fence is gated behind the `memoryCutoverComplete` CDK context flag: only after the
import transaction has committed the terminal frozen authority state, redeploy the
stack with `cdk deploy -c memoryCutoverComplete=true`. That deploy revokes the EC2
role's write access to the legacy graph bucket, adds the read-only
`/data/knowledge-graph` container mount, and sets
`PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY=1` in the service unit. Deploying the flag
before the cutover crash-loops the server fail-closed; deploying the stack without
the flag never raises the fence. Before starting PIM post-flag, verify IAM
simulation denies both `s3:PutObject` and `s3:DeleteObject` on the exact legacy
prefix.

Always pass the reviewed immutable server image digest when raising the fence:

```sh
cdk deploy PimEc2Stack-rkhan \
  -c memoryCutoverComplete=true \
  -c serverImageDigest=sha256:REVIEWED_IMAGE_DIGEST \
  --require-approval never
```

The deployment workflow reads `MemoryCutoverComplete` from this same stack and
carries it forward. Once the output is `true`, ordinary releases cannot silently
lower the terminal fence or switch the unit back to `:latest`.

The container cannot restore an empty read-only graph mount. A replacement host
must restore and checksum the retained graph archive (or sync the read-only S3
prefix) onto its data volume before the container starts. If legacy graph reads are
intentionally retired, remove that dependency explicitly; never treat an empty
mount as a successful restore.

The application guards and SQLite triggers are defense in depth. Deployment policy
must reject every image below the pinned authority-fence image digest; merely
containing migration `009` is not sufficient.

The post-cutover stack deploy (`-c memoryCutoverComplete=true`) sets
`PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY=1` in the service unit. Startup
must fail if a restored database is missing the terminal frozen authority state;
this prevents a pre-cutover database restore from silently reviving SQL writers.

Only after the filesystem, IAM, image-floor, and canonical-authority checks above
pass, remove the runtime mask and start the pinned authority-fence image:

```sh
systemctl unmask --runtime pim-server.service
systemctl start pim-server.service
```

The process must pass its canonical-authority startup assertion before it can
become healthy.

No legacy source deletion or retention cleanup is part of this cutover.

## Failure and rollback

- Failure before the import transaction commits leaves the database under legacy
  authority and leaves every source untouched. Correct the input and retry while
  PIM stays stopped.
- A crash after commit is a canonical recovery, not a rollback to a legacy writer.
  Re-run reconciliation or replay the identical apply command.
- To disable behavior after commit, keep prompt exposure off and use the project
  kill switches. Fix forward or restore a verified **post-cutover canonical** backup.
- Never start PIM directly from the pre-cutover database after canonical authority
  has committed. If that copy is needed for disaster recovery, restore it in an
  isolated environment, rerun this cutover, verify canonical authority, and only
  then publish it.

These rules make rollback unable to reactivate a legacy write authority while
retaining every original byte needed for recovery or audit.
