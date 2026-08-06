# Confirmed findings remediation plan

- **Status:** Proposed implementation plan
- **Prepared:** 2026-08-05
- **Scope:** Five confirmed code defects and one composite infrastructure rollout blocker
- **Availability assumption:** Planned full downtime is approved; there are no active users
- **Preservation rule:** Organization and knowledge-graph data are critical; only derived project-search state is disposable
- **Important:** This document is a plan. It does not apply code, data, or AWS changes.

## Executive summary

The application fixes are mostly small. Because planned downtime is acceptable, this
deployment should be run as an **offline data migration**, not as a rolling or
zero-downtime release. Stop every writer, suspend automatic instance replacement,
create and test multiple independent recovery copies, complete the canonical-memory
cutover, and only then replace the host.

The primary transfer artifact should be an application-consistent EBS snapshot of the
entire stopped `/data` volume. That snapshot preserves the SQLite database **and** all
local knowledge-graph files together. A verified portable SQLite core backup and
separately checksummed archives of every local and S3 graph root are independent
recovery paths. Losing `project_search_*` tables, FTS rows, search embeddings, or
search caches is acceptable because they can be rebuilt.

The safest order is:

1. Hold automatic deployment and build/test the fixed, digest-pinned image without
   replacing the current instance.
2. Start the maintenance window: suspend ASG health replacement, stop and mask the
   service, stop scheduled writers/backups, and checkpoint SQLite's WAL.
3. Capture a pre-cutover database copy, verified logical backup, exact organization
   and table-content manifest, every KG root/archive, the KG S3 version inventory,
   and a completed whole-`/data` EBS snapshot.
4. Test the database, graph archives, and snapshot restore before modifying the
   original volume.
5. Complete the documented offline canonical-memory cutover.
6. Repeat the manifests, archives, logical backup, and whole-volume snapshot to
   create the final **post-cutover** transfer set.
7. Launch the corrected template from the final snapshot, then prove that org data,
   SQL knowledge data, and every JSON graph match the final transfer manifest before
   resuming any writer.
8. Discard/rebuild project-search state after the authoritative data checks pass.
9. Re-ingest data damaged by the OpenAI-key false positive as a separate, backed-up
   repair operation.

The CloudWatch missing-heartbeat alarm and the canonical-authority assertion are
working as intended. They must stay fail-closed. The correction is to make sure the
publisher is installed and the cutover prerequisite is completed before rollout.

## Approved availability and data-preservation boundary

Downtime simplifies the deployment substantially: there is no need to keep the old
and new servers serving traffic at the same time, no need for a partial-search
availability target, and no need to publish a rebuilt search index before handoff.
It does **not** relax any data-integrity gate.

| Data class | Deployment treatment | Required proof |
|---|---|---|
| Organization data | Preserve. This includes `orgs`, membership/invite/settings data, projects, pods, context, evidence, connector configuration/cursors, and every other non-search SQLite table. | Exact table list, row counts, deterministic row-content digests, exact org-ID set, integrity check, and foreign-key check before and after transfer. |
| Canonical memory and audit data | Preserve. Memory records, candidates, entities, relationships, receipts, decisions, authority transitions, migration ledgers, and audit history are not search cache. | Deterministic table digests plus cutover reconciliation/ledger checks. |
| SQL knowledge data | Preserve `knowledge_nodes` and any canonical memory representation of KG content, including stored metadata and embeddings. | Exact `knowledge_nodes` row count and deterministic content digest, plus cutover reconciliation. |
| Local JSON knowledge graphs | Preserve every configured graph root, every org directory, `graph-latest.json`, retained `graph-v*.json` versions, nodes, edges, communities, metadata, and embeddings. | Per-file path/size/SHA-256 manifest and parsed per-org graph version/node/edge counts. |
| S3 knowledge-graph authority | Preserve the exact prefix, current objects, and versioned-object inventory. Do not assume the local root contains every remote-only version. | Version inventory, synced archive, archive SHA-256, and reconciliation against every local root. |
| Project-search derived state | Disposable: tables matching `project_search_*`, project-search FTS, search chunks/embeddings, search entities/edges, and the context-search cache may be purged. | A rebuild marker or explicit reindex plan; no equality requirement during transfer. |

The project-search graph index is not the knowledge graph. In particular,
`project_search_entities` and `project_search_edges` may be rebuilt, while
`knowledge_nodes`, canonical memory/KG rows, `/data/knowledge-graph`, and the KG S3
prefix must be preserved.

The existing `backup.sh` core format excludes only `project_search_*` tables. It
therefore includes organization and SQL knowledge data. Its current count manifest is
a useful gate but is not sufficient for this zero-loss transfer by itself: equal row
counts do not prove equal content. Extend the transfer manifest to include
deterministic per-table row digests and the exact org-ID set.

For deterministic SQL digests, record the schema name/version and column metadata,
serialize each value with an unambiguous type marker (including `NULL` and binary
data), sort rows by primary key or by the complete encoded row when no key exists,
and hash the resulting stream. Generate and compare the manifest with the database
offline so timestamps or background jobs cannot change it during measurement. Do
not hard-code only today's org tables: include every non-search table so a newly
added authoritative table cannot be omitted accidentally.

## Findings and intended outcomes

| Finding | Severity | In plain English | Intended result |
|---|---:|---|---|
| EC2 sysfs path typo | Critical | A new server asks Linux for its instance ID using a filename that does not exist, so setup stops halfway through. | New instances identify themselves, tag the correct data disk, install the service and cron, and become healthy. |
| Prototype-chain validator bypass | High | A field named like a built-in JavaScript method can slip past the “no extra fields” rule and make later hashing crash. | Built-in property names are treated as ordinary unknown fields and rejected before hashing. |
| Confluence code-point crash | High | One malformed character reference on one page can stop all new Confluence changes for that project. | Invalid references become the standard replacement character, double-encoded text is decoded only once, and the rest of the poll continues. |
| OpenAI-key false positive | High | Normal words containing `sk-`, such as the end of “risk-” or “task-”, are mistaken for API keys and permanently replaced. | Real-looking keys are still blocked, ordinary identifiers remain unchanged, and previously damaged source data is re-ingested. |
| Backfill failure isolation | High | One obsolete or malformed evidence row can stop all later rows from being added to project search. | Bad rows are skipped and reported individually while every valid row is still indexed. |
| Infrastructure rollout composite | High blocker | Backup selection, heartbeat monitoring, and the authority check are individually correct, but rollout order can prevent them from ever reaching a healthy state. | A machine-verifiable preflight gate enforces backup, cutover, image, and volume prerequisites before replacement. |

### Current defect locations

These line numbers describe the working tree reviewed on 2026-08-05 and may move as
the fixes are implemented.

| Area | Current location | Relevant behavior |
|---|---|---|
| EC2 bootstrap | `packages/infra/lib/pim-ec2-stack.ts:442` | Reads `board_asset` before tagging the data volume. |
| Contract validator | `packages/shared/src/contracts/memory-contracts.ts:139` | Uses inherited `properties[name]` lookup. |
| Confluence decoder | `packages/server/src/services/project-confluence-source.ts:264-273` | Sequential replacements end in unchecked `String.fromCodePoint`. |
| Secret scanner | `packages/server/src/services/secret-scan.ts:14` | OpenAI pattern has no token boundary. |
| Search backfill | `packages/server/src/services/project-search-index.ts:1328-1389` | A row exception escapes the evidence loop. |
| Restore recovery | `packages/server/src/services/project-search-recovery.ts:80-83` | Purges derived state before backfill and later indexing stages. |
| Deployment entry point | `docs/DEPLOY.md:62` | Starts deployment without making offline cutover a blocking gate. |
| Documented authority gate | `docs/MEMORY_OFFLINE_CUTOVER.md:279-292` | Correctly requires canonical authority before health. |

## Definition of done

### Deployment handoff

The offline transfer is complete when all of the following are true, even if project
search is still empty or rebuilding:

- The restored database passes `PRAGMA integrity_check` and has no foreign-key
  violations.
- Its non-`project_search_*` table set, row counts, and deterministic row-content
  digests exactly match the final post-cutover transfer manifest.
- Its exact org-ID set matches, and the org, membership, settings, invite, project,
  pod, evidence, context, connector, memory, receipt, decision, and audit-table
  digests all match.
- Its `knowledge_nodes` count and content digest match.
- Every required local JSON graph file matches the final per-file SHA-256 manifest,
  and every parsed org graph matches its recorded org ID, version, node count, and
  edge count.
- The KG S3 object-version inventory and archived current prefix are retained and
  checksummed, including any remote-only layout.
- The deployed database reports canonical authority with legacy writes frozen before
  the service is allowed to become healthy.
- The old data volume, pre-cutover snapshot, post-cutover snapshot, logical backups,
  database copies, graph archives, and manifests remain retained and read-only.
- No project-search count or digest is used as a handoff gate. A rebuild marker or
  explicit reindex task is sufficient.

### Full remediation

The complete bug-remediation program is done only when all of the following are also
true:

- A newly launched ASG instance becomes healthy without repeated replacement.
- Its `/data` EBS volume has the expected `PimBackup` tag and a completed AWS Backup
  recovery point.
- `pim-server.service` and `/etc/cron.d/pim-backup` exist and are active/applicable.
- The hourly `PIM/Backup LogicalBackupSuccess` metric is published; missing data
  remains configured as breaching.
- A contract payload with own fields named `toString`, `constructor`,
  `hasOwnProperty`, or `__proto__` receives a validation error, not a server error.
- The 5,000-level proof-of-concept payload is rejected before
  `canonicalJsonSha256` and does not produce a stack overflow.
- Confluence pages containing `&#1114112;`, `&#x110000;`, surrogate references, and
  `&amp;#1114112;` do not fail the poll or prevent valid pages from being applied.
- `risk-analysis-dashboard-update` and
  `task-orchestration-migration-strategy` survive scanning, redaction,
  persistence, retrieval, and cache round trips unchanged.
- Synthetic legacy and project-style OpenAI keys are still detected and redacted,
  including an explicitly tested underscore-delimited context.
- A stale-bound evidence row does not prevent valid evidence, context updates, pod
  updates, KG nodes, embedding work, or graph annotation from being attempted.
- Startup recovery retains its marker for unexpected row failures, removes it after
  a complete rebuild, and never deletes authoritative evidence.

## Phase 0: immediate containment

These are operational precautions to take before merging or deploying the fixes.

1. **Pause automatic deployment, launch-template rollout, and ASG instance refresh.**
   Put the `deploy-mvp` workflow behind a temporary environment approval or deploy
   hold. The existing already provisioned instance is not affected by the missing
   sysfs file; replacement is the dangerous event.
2. **Resolve the current instance and its exact `/dev/sdb` attachment read-only.**
   Check whether that volume has `PimBackup=pim-<owner>-data`.
3. **If the tag is missing, apply it to that exact volume and create an on-demand
   recovery point.** Do not rely on the scheduled plan until a completed recovery
   point is visible. AWS Backup tag selection includes resources by their assigned
   tags; an untagged volume is outside this plan.
4. **Inventory every organization and graph authority.** Record the exact org-ID set,
   every configured local graph root, each graph's org/version/node/edge counts, and
   the KG S3 prefix/version inventory. A portable SQL backup does not contain the
   JSON graph roots.
5. **Verify the logical backup separately.** Confirm the newest S3 dump and checksum
   sidecar can be imported, and determine whether the heartbeat metric is currently
   arriving. A missing metric should continue to alarm.
6. **Do not bypass the canonical-authority assertion.** If the current database is
   still under legacy authority, schedule the offline cutover before any instance
   replacement.
7. **Limit further false redaction.** If practical during the short remediation
   window, pause bulk evidence re-ingestion and memory imports that run through the
   affected secret scanner. Never attempt to “unredact” stored markers by guessing.
8. **Temporary Confluence mitigation.** If the offending page is known, correct the
   invalid entity in Confluence or temporarily remove that page from the configured
   project slice. Do not manually advance its watermark.

## Fix 1: correct EC2 instance identification during bootstrap

### Layman's explanation

The startup script is looking for an ID card in the wrong drawer. Because the script
is configured to stop on any error, it never reaches the steps that create the server
service or hourly backup job. The fix points it at the documented drawer and verifies
that what it read actually looks like an EC2 instance ID.

### Proposed code change

In `packages/infra/lib/pim-ec2-stack.ts`, replace:

```sh
INSTANCE_ID=$(cat /sys/devices/virtual/dmi/id/board_asset)
```

with the equivalent of:

```sh
INSTANCE_ID_FILE=/sys/devices/virtual/dmi/id/board_asset_tag
[ -r "$INSTANCE_ID_FILE" ] || {
  echo "EC2 instance-id sysfs file is unavailable" >&2
  exit 1
}
INSTANCE_ID=$(tr -d '[:space:]' < "$INSTANCE_ID_FILE")
case "$INSTANCE_ID" in
  i-*) ;;
  *) echo "Invalid EC2 instance ID from sysfs" >&2; exit 1 ;;
esac
```

AWS documents `/sys/devices/virtual/dmi/id/board_asset_tag` for Nitro instances:
[Detect whether a host is an EC2 instance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/identify_ec2_instances.html).

### Technical breakdown

- Keep `set -eu`. Starting the application with an unprotected stateful disk would
  hide the failure and weaken recovery guarantees.
- Trim only whitespace and validate the `i-...` shape before using the value in
  `DescribeVolumes`.
- Continue resolving the data volume by both attachment instance ID and
  `/dev/sdb`; do not tag every volume in the launch template.
- Keep the existing least-privilege `ec2:CreateTags` condition, which allows only
  the expected key and value on EBS volumes.
- Add a clear boot-stage log before instance lookup, tag creation, service creation,
  and cron creation so a future bootstrap failure is visible in cloud-init output.
- Preserve the order “mount data volume -> identify/tag it -> pull image -> install
  service -> install cron.” The application must not become healthy before its
  stateful volume is protected.

### Tests and acceptance checks

- Add an infrastructure synth test that inspects rendered user data and asserts:
  - `board_asset_tag` is present;
  - the obsolete `board_asset` path is absent;
  - instance-ID validation occurs before `describe-volumes`;
  - `create-tags` occurs before `systemctl enable --now pim-server`;
  - service creation occurs before cron creation.
- Run `pnpm --filter @pim/infra typecheck` and synth the named stack.
- In a disposable Nitro instance or controlled ASG replacement, verify the sysfs
  value matches the EC2 API instance ID and the selected volume is the actual
  `/data` attachment.
- Require one stable healthy instance beyond the five-minute ASG grace period; a
  launch followed by replacement is a failed acceptance test.

### What changes

Existing instances do not change until their launch template is applied through a
replacement. Newly launched instances finish provisioning instead of stopping before
the service and cron steps. A genuine inability to identify or tag the volume still
fails closed, but now emits a useful error.

## Fix 2: close the prototype-chain validator bypass

### Layman's explanation

JavaScript objects inherit built-in names such as `toString`. The validator currently
mistakes an inherited built-in name for a field listed in the schema. An attacker can
put a deeply nested value behind that name, causing the hashing step to run out of
stack space. The fix asks, “Does the schema itself own this field?” instead of “Can
this name be found anywhere on the schema object?”

Authentication and request-body size limits reduce how easily the issue can be
triggered, but they do not restore schema integrity or guarantee request availability.

### Proposed code change

In `packages/shared/src/contracts/memory-contracts.ts`, change the property lookup
inside the object-entry loop from a truthy inherited lookup:

```ts
if (properties[name]) {
```

to an own-property check:

```ts
if (Object.prototype.hasOwnProperty.call(properties, name)) {
  issues.push(...validateNode(properties[name]!, child, [...path, name]));
```

The `call` form is important because neither the input nor the schema object should
be trusted to provide a safe `hasOwnProperty` method.

### Technical breakdown

- Apply the own-property rule at the shared validator, not independently in routes;
  this closes the issue for every current and future memory object contract.
- Keep required-field checks on `Object.prototype.hasOwnProperty.call`, as they
  already are.
- With `additionalProperties: false`, inherited names now produce the same
  `unknown field` issue as any other extra key.
- With a schema for `additionalProperties`, validate the value against that schema;
  do not consult `Object.prototype` for a property definition.
- Ensure callers validate before generating idempotency or canonical JSON digests.
  Invalid payloads should result in the existing contract-validation response and
  never reach `canonicalJsonSha256`.
- As defense in depth, add a bounded structural-depth/node-count check at the
  contract boundary so any future recursive schema fails with a controlled
  validation issue rather than a JavaScript `RangeError`. This limit must be above
  the maximum depth of all published fixtures and documented as an input limit.

### Tests and acceptance checks

- Extend `packages/server/src/services/__tests__/memory-contracts.test.ts` with
  own enumerable fields named `toString`, `constructor`, `hasOwnProperty`,
  `valueOf`, and `__proto__`.
- Construct `__proto__` with `Object.defineProperty` or `JSON.parse` so the test
  creates an own data property rather than changing the test object's prototype.
- Run the cases against every top-level object contract fixture, not only
  `MemorySearchV1`.
- Assert the exact JSON Pointer and `unknown field` reason.
- Reproduce the 5,000-level `toString` payload and assert bounded runtime, no
  `Maximum call stack size exceeded`, no digest generation, and a client error at
  the HTTP route.
- Retain canonical JSON golden-vector tests to prove accepted payload digests do not
  change.

### What changes

Clients that send built-in JavaScript names as undeclared fields will now receive a
schema error. Valid requests and their canonical digests stay identical. This is an
intentional tightening of the trust boundary, not a contract-version change.

## Fix 3: use a standards-compliant, single-pass Confluence entity decoder

### Layman's explanation

The current decoder performs several replacements in sequence. It first turns
`&amp;` into `&`, which can expose a second encoded value that the same call then
decodes again. It also passes out-of-range numbers directly to a JavaScript function
that throws. One bad page therefore makes the poll report a failure, and the sync
correctly applies none of the changes collected during that failed poll. Previously
indexed Confluence content remains available, but it becomes stale while the page
continues to fail; other connectors continue independently.

A proper HTML decoder reads the original text once. Invalid Unicode numbers become
the replacement character `�`, and text that was intentionally encoded twice remains
encoded once for a later layer instead of being decoded recursively.

### Proposed code change

- Add `entities` as a **direct** server dependency and update `pnpm-lock.yaml`. It is
  currently only a transitive lockfile entry and must not be imported without a
  direct declaration.
- Replace the hand-written `decodeHtml` replacement chain in
  `packages/server/src/services/project-confluence-source.ts` with one call to the
  library's HTML text-context decoder.
- Keep tag-to-newline conversion, tag removal, whitespace normalization, section
  splitting, visibility checks, and secret redaction as separate later steps.

The WHATWG parser defines out-of-range numeric references as parse errors that resolve
to U+FFFD rather than throwing: [HTML Standard, character-reference parsing](https://html.spec.whatwg.org/multipage/parsing.html#character-reference-state).

### Technical breakdown

- Decode the original Confluence storage string once. Do not run the result through
  the decoder again.
- Accept decimal and hexadecimal numeric references and the standard named-entity
  table.
- Expected examples after one pass:
  - `&#1114112;` -> `�`;
  - `&#x110000;` -> `�`;
  - a surrogate reference -> `�`;
  - `&amp;#1114112;` -> the literal text `&#1114112;`;
  - a valid supplementary character reference -> that Unicode character.
- Do not merely clamp invalid numbers to `0x10FFFF`; clamping changes the author's
  text to a different valid character and is not HTML parsing behavior.
- Keep the existing poll/sync contract. Unexpected poll errors should still return a
  sanitized `confluence_poll_failed`, and a failed poll should still apply none of
  its accumulated changes or advance reconciliation state.

### Tests and acceptance checks

- Add table-driven section-decoding tests for decimal, hexadecimal, zero,
  out-of-range, surrogate, C1 control, valid supplementary, named, unknown, and
  double-encoded references.
- Add a poll test with at least two pages where the first contains each former crash
  input and the second is normal. Assert `complete: true`, no `missing`, and changes
  from both pages.
- Add a separate real fetch/pagination failure test proving accumulated changes are
  still deliberately discarded by `syncConfluenceProjectSource` and the watermark
  is not advanced.
- Verify the output contains no lone UTF-16 surrogate and can be normalized,
  persisted, indexed, and JSON-encoded.

### What changes

Malformed character references can produce `�` in indexed text, but they no longer
make all Confluence content for the project stale. Standard named entities will be
decoded more completely than the current six-name list. Connector isolation remains
unchanged: Confluence failure does not stop other connectors.

## Fix 4: remove the OpenAI-key false positive and repair affected data

### Layman's explanation

The scanner looks for any long text beginning with `sk-`, even when those letters are
the end of an ordinary word. In `risk-analysis-dashboard-update`, for example, it
starts reading at the `s` in “risk” and treats the rest like a key. Once the text is
replaced with a redaction marker, rebuilding the search index cannot recover the
missing letters because the original value is already gone.

The code fix adds a left and right token boundary. The data fix re-fetches the
original content from its real source and runs it through the corrected scanner.

### Proposed code change

In `packages/server/src/services/secret-scan.ts`, define the OpenAI pattern with
explicit token boundaries, equivalent to:

```ts
/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/
```

This blocks a match whose `s` is part of an alphanumeric word such as `risk` or
`task`, while still detecting a key at the start of text or after punctuation,
assignment characters, whitespace, or an underscore delimiter. The same source
pattern must drive both scanning and global replacement.

Also bump `PROJECT_EVIDENCE_REDACTION_VERSION` in
`packages/server/src/services/project-evidence-normalization.ts` from v1 to v2.
That version change makes old normalized rows discoverable and prevents v1 and v2
content hashes from being treated as equivalent.

### Technical breakdown

- Do not use a bare `\b`; JavaScript treats underscore as a word character, which
  makes underscore-adjacent behavior easy to get wrong.
- Pin underscore behavior with tests:
  - snake-case ordinary identifiers remain clean;
  - a synthetic `sk-...` token following an underscore delimiter is still detected.
- Keep support for the existing broad legacy/project-style character set without
  depending on an undocumented exact key length.
- Verify `scanForSecrets` and `redactSecrets` agree on every fixture. A value must
  never be reported clean and then altered, or reported secret and left intact.
- Run the regression through `redactProjectText`, project evidence normalization,
  resource identifiers, search queries, memory request rejection, and cache output;
  testing only `scanForSecrets` is insufficient because this helper has many callers.
- Bump the context-search cache policy version and/or delete the old cache namespace
  during repair so v1 redacted results cannot be returned after the code fix.

### Tests and acceptance checks

- Add clean fixtures for:
  - `risk-analysis-dashboard-update`;
  - `task-orchestration-migration-strategy`;
  - `risk_analysis_dashboard_update`;
  - `task_orchestration_migration_strategy`;
  - the same strings next to quotes, JSON punctuation, URL path separators, and
    identifier delimiters.
- Add synthetic-secret fixtures at start of text and after `=`, whitespace, `/`,
  `-`, and `_`. Never put a real credential in a fixture.
- Assert both `clean/findings` and exact redacted output.
- Add persistence/retrieval tests proving the two reported values remain byte-for-byte
  intact in evidence identifiers, normalized hashes, search documents, results, and
  memory request handling.
- Retain positive tests for all other secret classes.

### Existing-data repair plan

An index-only rebuild is explicitly insufficient. Use a dedicated, auditable repair
tool with `report` and `apply` modes:

1. **Take a verified canonical backup and manifest.** Work on a copy first.
2. **Inventory candidates.** Search an explicit allowlist of authoritative text and
   JSON columns for `[REDACTED:OpenAI Key]` and record internal row ID, source type,
   source instance, redaction version, and a hash of the damaged value. Do not log
   bodies or possible credentials.
3. **Classify by source of truth.** A marker can represent a correctly redacted real
   key or a false positive; the marker itself is not proof of damage.
4. **Re-ingest externally authoritative records.** Re-fetch GitHub, Jira, Slack, and
   Confluence records using their stable native locator. If a locator was itself
   damaged, re-scan the smallest safe source scope and reconcile by untouched IDs,
   URLs, timestamps, or source versions.
5. **Reconstruct internally authoritative rows only from preserved originals.** Use
   pre-redaction backups, immutable audit artifacts, or the submitting system. Never
   infer missing text from a slug or replace the marker with guessed characters.
6. **Quarantine unresolved rows.** Keep an explicit unresolved report; do not silently
   mark the repair complete.
7. **Recompute normalized fields.** Persist v2 redaction version, normalized content
   hash, dependent idempotency digests, and any stable derived identifier that is
   defined from repaired content. For append-only memory, receipt, or audit ledgers,
   do not update a historical digest in place: append a supported correction or
   superseding version and preserve the original audit record.
8. **Invalidate derived state.** Purge/rebuild affected project-search documents,
   chunks, FTS rows, embeddings, graph annotations, query caches, and memory-derived
   views only after the authoritative row is repaired.
9. **Re-run the inventory.** Remaining markers must be explained as confirmed real
   secret redactions or unresolved records; zero unexplained candidates is the exit
   criterion.

The repair tool should be idempotent, default to report-only, require an explicit
backup/manifest reference for apply mode, and produce counts and hashes rather than
raw sensitive text.

### What changes

New ordinary identifiers stop being corrupted or rejected. Correctly shaped keys are
still redacted. Existing v1 rows remain unchanged until deliberately re-ingested or
reconstructed; there is no safe blanket SQL substitution.

## Fix 5: isolate project-search backfill failures by row

### Layman's explanation

Rebuilding search is like loading a stack of documents into a filing cabinet. Today,
one obsolete document jams the process and every document after it stays on the
floor. The fix labels and sets aside the bad document, keeps filing the good ones,
and reports that the rebuild was incomplete when the problem was unexpected.

Before the fix, a first-row failure can leave the restored project index empty, while
a later-row failure leaves the rows before it indexed and the rows after it missing.
That ordering-dependent distinction must be preserved in incident documentation.

### Proposed code change

Change `backfillProjectSearch` in
`packages/server/src/services/project-search-index.ts` to return a structured result,
for example:

```ts
interface ProjectSearchBackfillResult {
  documents: number;
  chunks: number;
  skipped_ineligible: number;
  failed_rows: number;
  complete: boolean;
  failures: Array<{ row_id: string; source: string; code: string }>;
}
```

Wrap each authoritative row's conversion/index call, not the entire project loop.
Continue to project updates and pod updates after an evidence-row error.

### Technical breakdown

- Load the current sanitized project-resource binding once, as the function already
  does.
- If connector evidence has no eligible current binding, classify it as
  `skipped_ineligible` rather than calling `indexProjectDocument` and throwing
  `resource_binding`.
- Ensure any matching old derived document is absent. Marker-driven recovery already
  purges first; routine backfill should also prune an existing natural key that is
  now ineligible without deleting the authoritative evidence row.
- For normalization, malformed-row, or unexpected database errors:
  - record a sanitized error code and internal row ID;
  - increment `failed_rows`;
  - continue with later rows;
  - do not log title, body, URL credentials, or raw metadata.
- Add the de-duplication key to `seen` only after successful indexing or a deliberate
  ineligible classification. A failed earlier duplicate must not suppress a valid
  later candidate.
- Preserve per-document transactions so a failed row cannot leave half of its
  chunks, FTS rows, or graph edges committed.
- Do not delete or rewrite authoritative evidence simply to make a derived index
  rebuild succeed.

Update callers as follows:

- **Normal six-hour refresh:** It does not purge first today and should remain that
  way. Continue KG indexing, embedding eligible chunks, and graph annotation after
  row failures. Return/log a degraded `project_backfill_partial` outcome with counts
  so the next refresh retries it.
- **Marker-driven startup recovery:** It is the path that currently purges each
  project's derived state before rebuilding. After the purge, index every valid row.
  Keep the rebuild marker if `failed_rows > 0`; remove it only when every project has
  no unexpected failures. Expected stale/ineligible rows do not keep the marker.
- **Live evidence hook:** Keep its non-throwing behavior, but use the same structured
  error classification and metrics so live and backfill behavior do not drift.

### Tests and acceptance checks

- Add backfill integration tests with the bad row first, middle, and last. Valid
  document and chunk counts must be identical in all three orders.
- Test an evidence row whose connector binding was removed. It should be skipped,
  leave no derived document, and leave the authoritative row untouched.
- Test an unexpected malformed row. Later evidence, project updates, and pod updates
  must still be indexed; the result must be `complete: false` with no raw content in
  its failure details.
- Extend `project-search-refresh.test.ts` to assert no purge is called, later stages
  are attempted, and the degraded result is retried on a later sweep.
- Extend `project-search-recovery.test.ts` to assert:
  - purge is marker-driven;
  - valid rows are rebuilt despite one failed row;
  - the marker remains for unexpected failures;
  - the marker is removed when only stale/ineligible rows were skipped;
  - other projects continue rebuilding.
- Verify search can return the valid subset while a marker is retained and becomes
  complete after the repaired row succeeds on retry.

### What changes

One bad row no longer determines whether later rows are searchable. During normal
refresh, the existing index is not purged and valid new rows continue to accumulate.
During startup recovery, derived state is purged first and then all valid rows are
repopulated, so the result can be partial while the marker records that more work is
required. Authoritative evidence remains safe in both paths.

Under the approved deployment assumptions, this fix is **not a transfer blocker**.
The deployment may hand off with project search empty or partially rebuilt. Complete
this fix before project search is declared operational, not before org/KG data is
transferred.

## Fix 6: make infrastructure rollout a gated sequence

### Layman's explanation

The backup plan, missing-heartbeat alarm, and database safety lock are doing what
they were designed to do. The rollout is asking them to succeed in the wrong order:
the disk may not get its backup tag, the heartbeat job may never be installed, and
the new application is intentionally unwilling to start against an old database.

Because downtime is approved, the solution is to stop the old server completely,
snapshot the whole data disk, and start the replacement from that stopped-state
snapshot. This preserves the database and local KG files together. Independent
logical database and KG-archive restores remain mandatory so the snapshot is not the
only recovery path.

### Behaviors to preserve

- Keep tag-selected AWS Backup. AWS documents that a plan's resource assignment may
  include resources by tags: [Select AWS services to backup](https://docs.aws.amazon.com/aws-backup/latest/devguide/assigning-resources.html).
- Keep `LogicalBackupHeartbeatAlarm` configured with missing data as breaching.
  CloudWatch explicitly supports treating a continuously expected metric's missing
  data as bad: [Configuring how CloudWatch alarms treat missing data](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html).
- Keep `PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY=1` and its fail-closed startup error.
- Keep the legacy graph mount and IAM permissions read-only after cutover.
- Preserve all org data, `knowledge_nodes`, canonical memory/KG records, every local
  JSON graph root, and the KG S3 object/version inventory.
- Permit only `project_search_*` and explicitly named search/cache derivatives to be
  discarded.

### Proposed orchestration changes

1. **Add a deterministic transfer-manifest tool.** Extend
   `capture-manifest.sh` or add a report-only companion that records the exact
   non-search table set, row counts, deterministic row-content digests, exact org-ID
   set, `knowledge_nodes` digest, and a per-file KG path/size/SHA-256 manifest with
   parsed org/version/node/edge counts. Use typed, length-delimited values and stable
   row ordering so delimiters, `NULL`, text, and blobs cannot hash ambiguously.
   Count-only comparison is not enough.
2. **Add a read-only rollout preflight script.** A root-level script such as
   `scripts/check-ec2-rollout-readiness.sh` should resolve the stack, ASG, current
   instance, and exact `/data` volume, then exit nonzero unless:
   - the expected backup tag is present on that volume;
   - all configured graph roots and every org are accounted for;
   - the KG S3 object-version inventory and synced current-prefix archive exist;
   - a verified logical dump, checksum, and deterministic transfer manifest exist;
   - a stopped-state whole-`/data` snapshot is complete;
   - the latest authority transition is `canonical` with
     `legacy_writes_frozen = 1`;
   - the authority-fence image digest is known and is not below the approved floor;
   - IAM simulation denies legacy-bucket writes; and
   - the operations-alert subscription is confirmed.
3. **Make the maintenance stop explicit.** Before the final artifacts, suspend the
   ASG processes that can replace or refresh the instance, stop and runtime-mask
   `pim-server`, stop cron and all application workers, confirm no container/process
   holds the database, checkpoint the WAL, and keep the host offline until the final
   snapshot reports `completed`.
4. **Seed the migration launch from the stopped-state snapshot.** Add a reviewed,
   one-time CDK context such as `dataVolumeSnapshotId`. When present, create `/dev/sdb`
   with `ec2.BlockDeviceVolume.ebsFromSnapshot(...)`; otherwise retain the normal
   empty-volume behavior. Validate the snapshot ID at synth, retain encryption/GP3
   settings, and keep `deleteOnTermination: false`.
5. **Add a pre-start KG restore for future empty volumes.** The server's current
   `restoreGraphFromS3IfEmpty` deliberately returns without writing once legacy
   writes are frozen. Therefore a post-cutover empty host cannot rely on the
   application to recreate `/data/knowledge-graph`. Publish a pinned, checksummed KG
   archive and manifest, restore it on the host into a staging directory, verify all
   files/orgs/graph counts, atomically install it, and only then mount it read-only
   into the container.
6. **Pin one complete recovery set.** Assign one immutable recovery-set ID to the
   final stopped state. Its signed/checksummed manifest must link the core-backup key
   and SHA-256, deterministic SQL manifest, every KG archive and its SHA/manifest,
   the S3 object-version inventory, authority/cutover state, and EBS snapshot ID.
   Restore all components from that one set; never combine independently selected
   “latest” database and KG artifacts.
7. **Integrate the offline path into every deploy entry point.** Update
   `docs/DEPLOY.md`, `.github/workflows/deploy-mvp.yml`, and
   `docs/AGENT_MANUAL_DEPLOY.md` so automatic deploy remains held until the operator
   supplies the approved artifact set and the cutover runbook passes.
8. **Build before replacement and pin by digest.** Build and push the reviewed image,
   resolve its immutable ECR digest, pass `serverImageDigest` to CDK, and avoid using
   mutable `:latest` as the authority-fence floor.
9. **Verify authoritative data before writers resume.** Compare the restored DB and
   KG against the final manifest while the replacement is still in maintenance mode.
   Search tables may be absent. Any org/KG mismatch fails the deployment.
10. **Remove the one-time snapshot seed after success.** Once the replacement has
    produced new verified backups, update the normal launch template back to an empty
    data volume plus fail-closed restore of one complete logical-DB/KG recovery set.
    Do not leave a stale migration snapshot as the source for all future replacements.

### Deployment acceptance gates

| Gate | Required evidence | Stop condition |
|---|---|---|
| Current data safety | One immutable recovery-set manifest links the verified logical import, graph archives/S3 inventory, authority state, and completed stopped-state EBS snapshot for the exact current volume | Missing or cross-generation artifact, checksum failure, failed restore drill, or incomplete snapshot |
| Organization data | Exact org-ID set and deterministic content digests for every non-search org/config/project/pod/evidence/context table match the final manifest | Any missing/extra org, table, row, or content-digest mismatch |
| SQL KG/canonical memory | `knowledge_nodes` and all canonical memory/KG/ledger table digests match | Any count/digest/reconciliation mismatch |
| Local JSON KG | Every graph-root file hash and parsed org/version/node/edge count matches | Missing root/file/org, parse error, or hash/count mismatch |
| S3 KG | Versioned inventory and synced current-prefix archive are retained and reconciled | Missing/remote-only data outside the archive or inventory mismatch |
| Memory authority | Latest transition is `canonical`; `legacy_writes_frozen = 1`; reconciliation and coverage equations pass | Legacy/migration-locked state or incomplete report |
| Image | Reviewed digest at or above authority-fence floor | Mutable-only tag or older digest |
| IAM/filesystem | Legacy graph roots are read-only and S3 put/delete simulation is denied | Any legacy write succeeds |
| Bootstrap | Correct sysfs path, snapshot-seeded data volume, tag call, DB check, KG manifest check, unit, and cron all succeed | Any stage missing or automatic replacement begins |
| Runtime | Health endpoint is good, target stays healthy, expected digest is running | Restart loop, old image, or unhealthy target |
| Logical backup | A new dump verifies and publishes `LogicalBackupSuccess=1` with the deployment dimension | Missing/zero metric; do not change alarm semantics |
| Volume backup | Tag-selected job completes for the new `/data` volume | No selection or failed/expired job |
| Project search | No transfer equality requirement; it may be empty with rebuild requested | Never block handoff solely on derived search state |

### What changes

The deployment becomes a planned outage with an exact, testable transfer boundary.
Organization and KG data have multiple independent recovery copies and content-level
equality gates. Search availability is removed from the critical path. The alarm and
authority assertion may still block a genuinely unsafe rollout; that is expected.

## Implementation work packages

Keep the changes reviewable and avoid combining data repair with the initial code
patch.

### Work package A: trust-boundary and connector fixes

Files expected to change:

- `packages/shared/src/contracts/memory-contracts.ts`
- `packages/shared/src/canonical-json.ts` only if a controlled structural limit is
  implemented there rather than at the contract boundary
- `packages/server/src/services/project-confluence-source.ts`
- `packages/server/src/services/secret-scan.ts`
- `packages/server/src/services/project-evidence-normalization.ts`
- `packages/server/package.json`
- `pnpm-lock.yaml`
- focused validator, Confluence, scanner, normalization, and route tests

This package should contain no AWS rollout and no data mutation.

### Work package B: search failure isolation

Files expected to change:

- `packages/server/src/services/project-search-index.ts`
- `packages/server/src/services/project-search-refresh.ts`
- `packages/server/src/services/project-search-recovery.ts`
- their focused tests

This package defines the structured result first, updates all callers in the same
change, and documents which failures are expected skips versus incomplete rebuilds.
It is required before project search is declared repaired, but it is not a blocker
for the offline org/KG transfer.

### Work package C: bootstrap and rollout gate

Files expected to change:

- `packages/infra/lib/pim-ec2-stack.ts`
- a new infrastructure synth test and test script if needed
- `scripts/check-ec2-rollout-readiness.sh`
- an extended `packages/server/scripts/capture-manifest.sh` or a new deterministic
  content-manifest companion
- a fail-closed host/pre-start KG archive restore script
- `.github/workflows/deploy-mvp.yml`
- `docs/DEPLOY.md`
- `docs/AGENT_MANUAL_DEPLOY.md`
- cross-links to `docs/MEMORY_OFFLINE_CUTOVER.md` and `docs/BACKUP_RESTORE.md`

This package must be reviewed as one deployment change because the sysfs fix,
snapshot-seeded transfer, KG restore, publisher installation, backup selection, and
authority prerequisite interact.

### Work package D: audited data repair

Files expected to change:

- a report-first repair script under `packages/server/src/scripts/`
- script-level tests using a copied test database and mocked source adapters
- an operator runbook containing inventory, backup, apply, verification, and rollback

Run this package only after work package A is deployed. It must never attempt to
reverse a redaction marker without an authoritative original.

## Verification matrix

Run focused tests first, then the package and monorepo gates.

| Area | Minimum automated verification |
|---|---|
| Shared contracts | Contract fixtures, prototype-name matrix across object contracts, deep proof of concept, canonical digest goldens, shared typecheck |
| Confluence | Entity table tests, multi-page poll, failure-discard/watermark test, server typecheck |
| Secret scanning | Positive/negative boundary matrix, exact redaction output, persistence and route tests, normalization-version test |
| Search backfill | Bad-row ordering, stale binding, partial refresh, marker recovery, valid subset retrieval |
| Transfer manifests | Deterministic SQLite row-digest fixtures, exact org-ID comparison, KG file/hash/count fixtures, mismatch fail-closed tests |
| KG restore | Pinned archive/checksum/manifest tests, traversal/symlink rejection, staging cleanup, atomic publish, frozen-authority empty-volume test |
| Infrastructure | Infra typecheck, CDK synth, snapshot-seeded and normal empty-volume templates, rendered user-data ordering, IAM/backup assertions |
| Full repository | `pnpm typecheck`, `pnpm test`, and `pnpm build` after focused suites pass |

The deployment smoke test must additionally verify:

1. the running ECR digest equals the approved digest;
2. cloud-init and the pre-start data gates completed without an error;
3. `/data` is the intended EBS filesystem, was created from the approved final
   snapshot for the migration, and is not the image-factory scratch disk;
4. SQLite integrity/foreign keys pass and every non-search table digest matches;
5. the exact org-ID set and all org-related table digests match;
6. `knowledge_nodes` and canonical memory/KG digests match;
7. every local JSON graph file hash and parsed org/version/node/edge count matches;
8. the KG S3 version inventory and archived prefix remain retained;
9. the legacy graph roots are mounted read-only after verification;
10. the new volume has the exact backup tag;
11. `pim-server` remains active and the ALB target remains healthy;
12. the cron file exists with the metric-publishing wrapper;
13. a new logical backup imports cleanly and publishes its metric;
14. a new AWS Backup job selects and protects the new volume; and
15. representative org, memory, and KG reads return expected content without
    requiring project search to be populated.

## Offline deployment sequence

### Before the maintenance window

1. Put the automatic deployment workflow behind an approval/hold.
2. Implement and verify work packages A and C. Work package B may be included, but
   its search availability is not a transfer gate.
3. Build and push the reviewed authority-fence image, record its immutable digest,
   and synthesize both the one-time snapshot-seeded and normal empty-volume launch
   templates.
4. Resolve and record the current instance, `/data` volume ID, filesystem UUID, org
   IDs, graph roots, KG S3 bucket/prefix, and current authority state.
5. Ensure the current volume has the expected backup tag and prove the existing
   logical and volume-backup paths before entering the outage.

### During the maintenance window

6. Suspend the ASG processes that can replace, refresh, or terminate the instance.
   Keep desired capacity unchanged and record exactly which processes must later be
   resumed.
7. Stop and runtime-mask `pim-server`; stop cron and every worker/scheduled job; prove
   there is no running PIM container and no process writing the database or graph
   roots.
8. Checkpoint/truncate SQLite WAL, run integrity and foreign-key checks, and capture
   the **pre-cutover** recovery set:
   - transactionally consistent SQLite copy and SHA-256;
   - verified portable core backup and sidecar;
   - full/core table manifests plus deterministic row-content digests and org IDs;
   - checksummed archive of every graph root;
   - KG S3 version inventory, synced current prefix, archive, and checksums;
   - application-consistent EBS snapshot of the entire stopped `/data` volume; and
   - one manifest binding all of those artifacts to the same recovery-set ID.
9. Restore the pre-cutover database and graph artifacts in isolation and mount a
   volume cloned from the snapshot read-only. Do not proceed unless all manifests,
   content digests, graph parses/counts, and checksums pass.
10. Run the offline canonical-memory cutover using the reviewed authority-fence
    tooling, following `MEMORY_OFFLINE_CUTOVER.md`. Keep the service stopped.
11. Run all cutover reconciliation, coverage, authority, integrity, and read-only
    graph/IAM gates.
12. Capture the same artifact set again as the **final post-cutover transfer set**.
    Give every artifact an immutable key/ID and record its checksum in one immutable
    recovery-set manifest. The final EBS snapshot must reach `completed` before the
    old volume is detached or the old instance is terminated.
13. Restore-test the final logical database and KG archive and mount a clone of the
    final snapshot in isolation. Compare against the final transfer manifest. The
    final restored org IDs, all non-search table digests, `knowledge_nodes`, and all
    JSON graph file/count manifests must match exactly.

### Replace and verify

14. Configure the migration launch template with the corrected sysfs path, approved
    image digest, and final `dataVolumeSnapshotId`; keep project-search state out of
    the acceptance criteria.
15. Replace the instance while the application remains in maintenance mode. Preserve
    the old instance's data volume and every recovery artifact.
16. Before any application writer resumes, run the DB/org/KG pre-start gates against
    the new `/data`. Any mismatch stops the deployment; do not seed, prune, reindex,
    or “repair” authoritative data to make the comparison pass.
17. Start the service only after the authority, database, org, and KG gates pass.
    Verify direct org/memory/KG reads, the running image digest, service/target health,
    volume tag, cron installation, and read-only KG mounts.
18. Create and restore-test a new logical backup from the replacement and require a
    completed AWS Backup recovery point for its new volume.
19. Remove the one-time snapshot seed from the normal launch template and verify that
    future empty volumes fail closed unless they can restore a complete, checksummed
    DB/KG recovery set with one generation ID. Updating the template must not replace
    the now-verified host.
20. Resume the exact ASG processes and deployment workflow that were held.

### After authoritative handoff

21. Purge or ignore old `project_search_*` state and run reindexing. Search may remain
    unavailable while the backfill bug is corrected; org and KG handoff is already
    complete.
22. Run the OpenAI false-positive repair report, test it against a database copy, and
    re-ingest/reconstruct affected authoritative records in a separate backed-up
    operation.
23. Resume connector and memory ingestion, then monitor at least one logical backup
    interval and one AWS Backup schedule. Project-search refresh monitoring begins
    when search is re-enabled.

## Rollback and recovery rules

- Preserve both pre-cutover and final post-cutover database copies, logical backups,
  EBS snapshots, KG archives, S3 inventories, and manifests until the deployment and
  later data repair have passed all checks.
- Preserve the old EBS volume during the controlled replacement. Do not attach two
  writable SQLite/KG volumes to two active servers.
- Roll back only to an image at or above the pinned authority-fence digest floor.
- After canonical cutover, restore only a verified post-cutover canonical backup.
  A pre-cutover copy may be used only in isolation followed by a new cutover.
- A healthy HTTP response is not proof of a successful KG restore. Missing or
  mismatched org/KG data requires rollback even if the service starts.
- If replacement validation fails, keep the replacement offline and return compute
  to the retained post-cutover data volume/snapshot using the approved image. Do not
  revert production to a pre-cutover database.
- If the new instance fails bootstrap, stop replacement churn, keep the current/old
  volume intact, inspect the named boot stage, and fix forward. Do not remove the
  backup tag requirement, missing-data alarm, or authority assertion.
- If data repair counts do not reconcile, restore the pre-repair canonical copy and
  keep the fixed scanner deployed; do not run a blanket string substitution.
- A Confluence decoder rollback must not advance a watermark past content that was
  never applied.

## Review checklist

- [ ] The EC2 patch uses `board_asset_tag`, validates the instance ID, and has a
  rendered-user-data regression test.
- [ ] No change weakens `set -eu`, backup tag selection, missing-data handling, or
  canonical-authority enforcement.
- [ ] The transfer boundary explicitly preserves every non-search SQLite table,
  exact org IDs, `knowledge_nodes`, canonical memory/KG data, every graph root, and
  the KG S3 version inventory.
- [ ] Deterministic content digests, not row counts alone, gate org and KG transfer.
- [ ] One immutable recovery-set manifest binds the database, every KG archive, the
  S3 inventory, authority state, and snapshot to the same stopped generation.
- [ ] The stopped whole-`/data` snapshot and every independent logical/KG recovery
  artifact have been restore-tested before replacement.
- [ ] A frozen-authority empty volume restores the checksummed KG archive before the
  read-only container mount; it does not rely on `restoreGraphFromS3IfEmpty`.
- [ ] The one-time snapshot seed is removed from the normal launch template after a
  successful migration so future replacements do not start from stale data.
- [ ] Every schema property lookup is based on own properties.
- [ ] Prototype-name and deep-nesting tests fail safely before hashing.
- [ ] Confluence decoding is standards-based and exactly single-pass.
- [ ] The OpenAI-key pattern has explicit tested boundaries, including underscore
  behavior, and evidence normalization is versioned.
- [ ] The repair process re-ingests or reconstructs from authoritative originals and
  never guesses redacted text.
- [ ] Backfill returns structured partial-failure information and continues after a
  row error.
- [ ] The plan and tests distinguish normal six-hour refresh from marker-driven
  purge-then-rebuild recovery.
- [ ] Deployment docs, CI, and manual deployment all use the same cutover preflight.
- [ ] A controlled offline replacement proves org/KG equality, service health,
  logical heartbeat, volume tag, and EBS recovery point before writers resume.
- [ ] Project-search state is explicitly excluded from the authoritative transfer
  gate and rebuilt only after org/KG handoff.

## References

- [AWS EC2: Detect whether a host is an EC2 instance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/identify_ec2_instances.html)
- [AWS Backup: Select AWS services and assign resources](https://docs.aws.amazon.com/aws-backup/latest/devguide/assigning-resources.html)
- [Amazon CloudWatch: Configure how alarms treat missing data](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html)
- [WHATWG HTML Standard: Character-reference parsing](https://html.spec.whatwg.org/multipage/parsing.html#character-reference-state)
- [PIM backup and restore](./BACKUP_RESTORE.md)
- [PIM memory offline cutover](./MEMORY_OFFLINE_CUTOVER.md)
- [PIM AWS deployment runbook](./DEPLOY.md)
