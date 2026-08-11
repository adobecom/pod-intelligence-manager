# Memory v2 Slice 1 production-copy rehearsal

This runbook covers the disposable production-copy rehearsal required by Slice 1
of the Memory v2 simplification plan. It does not mutate production. The real
stopped-writer backup, count manifest, migration, and deployment happen once in
Slice 7.

## 1. Verify the production premise read-only

Resolve the existing PIM stack's instance and database path. Confirm the service
is healthy, then inspect the database from a process that has SQLite available:

```sh
sqlite3 -readonly /data/pim.db \
  'PRAGMA integrity_check; PRAGMA foreign_key_check;'
sqlite3 -readonly /data/pim.db \
  'SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version;'
sqlite3 -readonly /data/pim.db \
  'SELECT version,name FROM schema_migrations WHERE version >= 12 ORDER BY version;'
```

Require `integrity_check` to print `ok`, the foreign-key check to return no
rows, migrations `001` through `011` to match the reviewed ledger, and no row at
`012` or later. Stop if any premise differs. Do not rewrite or delete a ledger
entry.

## 2. Create an online SQLite backup

Use SQLite's backup API against the live database. Do not use `cp`, filesystem
snapshotting of only the main database file, or any other raw copy of a live WAL
database.

```sh
sqlite3 /data/pim.db \
  ".backup '/tmp/pim-memory-v2-slice1-rehearsal.db'"
sqlite3 -readonly /tmp/pim-memory-v2-slice1-rehearsal.db \
  'PRAGMA integrity_check; PRAGMA foreign_key_check;'
sha256sum /tmp/pim-memory-v2-slice1-rehearsal.db
```

Require the backup integrity check to print `ok` and its foreign-key check to
return no rows. Record the size and checksum in the operator change record.

## 3. Move the verified copy off-instance

Upload the verified database only to the existing PIM-owned backup location,
then download it into a disposable rehearsal directory. Verify that the
downloaded checksum exactly matches the on-instance checksum before removing the
temporary on-instance file.

Create a second local copy for migration work. Keep the downloaded verified copy
immutable so a failed rehearsal can be restarted without contacting production.

The Slice 1 backup is rehearsal input, not the authoritative launch backup and
not a count-manifest source. Do not reuse it as the Slice 7 safety artifact.

Executed rehearsal artifact (2026-08-11 UTC):

- S3 object: `s3://pim-rkhan-backups-947495650207/backups/memory-v2-slice1-rehearsal/pim-memory-v2-slice1-rehearsal-20260811T041916Z.db`
- Size: `119156736` bytes
- SHA-256: `cb68f8adaa3767015d33e8c45355632691c69bf6f0d7652c637d9b57dcf261e8`
- Verified local copy: `/private/tmp/pim-memory-v2-slice1-rehearsal-20260811T041916Z.verified.db`

The downloaded copy was rechecked locally with `PRAGMA integrity_check` (`ok`),
an empty `PRAGMA foreign_key_check`, and an 001–011 migration ledger. The S3
object has no checksum sidecar, so re-download it and compare it to the recorded
SHA-256 before the final disposable rehearsal. Slice 7 still creates a new
stopped-writer backup with its own checksum sidecar and manifests.

## 4. Rehearse only on the disposable copy

Apply the complete reviewed migration chain to the disposable working copy. The
temporary first-application fence for migrations `012` and `013` is supplied
only to this rehearsal process:

```sh
NODE_ENV=production \
PIM_MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION=apply-memory-v2-012-013 \
pnpm --filter @pim/server migrate-legacy-memory -- prepare \
  --db /absolute/disposable/path/pim-memory-v2-slice1-working.db
```

Immediately unset the confirmation after the command. It is not a normal
service setting and must never be placed in PIM secrets during Slice 1.

Require migrations through `018`, a clean integrity/foreign-key check, successful
startup reconciliation, unchanged active-record count, and honest
`trust_basis = 'legacy_cutover'` state for records trusted by the cutover. The
migration must not invent a new evidence-verification timestamp.

If the rehearsal fails, discard only the disposable working copy, make another
copy from the verified off-instance backup, and fix the implementation before
rerunning. Production remains on migrations `001` through `011` throughout
Slice 1.

## 5. Slice 7 remains the only production cutover

Do not stop writers, checkpoint production, capture a count manifest, set the
offline confirmation in PIM configuration, or deploy migrations during Slice 1.
Slice 7 performs those actions once, after the full HTTP/MCP and producer
verification matrix passes, using a new stopped-writer backup retained under the
normal recovery policy.
