# Memory v2 Slice 1 canonical-writer inventory

This is the Slice 1 exit artifact for the canonical stores that receive additive v2 resource,
binding, facet, or quarantine companions. It inventories the surviving runtime write entry points;
test fixtures and schema/migration DDL are not application writers.

Baseline reviewed: `5161be7` (`podFix`). The v1 HTTP contracts and route semantics remain
unchanged. The shared services below own the transaction, so a required v2 companion is committed
with its v1 authority/canonical row or neither is committed. Idempotent replays verify existing
companions and fail closed on drift; they do not repair a partial aggregate.

| Canonical area | Surviving write entry point | Slice 1 disposition |
|---|---|---|
| Repository authority | `registerMemoryRepository` | Owns an immediate transaction and projects the exact repository resource before commit. Existing-row replay verifies/projects the same authority row. |
| Repository rename/transfer | `renameMemoryRepository`, `transferMemoryRepository` | Keep the v1 registry authoritative and synchronously update the v2 resource and alias companions in the same transaction. Immutable provider/repository row identity, rather than the mutable display/canonical name, anchors token authority. |
| Harness authority | `createMemoryHarnessPrincipalBinding` | Owns an immediate transaction and creates the harness resource and principal-binding companions before commit. Existing-row replay resolves the same exact resource. |
| Service-token authority | `createServiceToken` and the staging-only private MCP issuer | The existing token and v1 repository/harness bindings are written with exact v2 token-resource bindings in the same transaction. Public issuance never adds the private MCP profile. |
| Pre-006 token compatibility | `backfillLegacyMemoryTokenBindings` | Owns a transaction around the legacy binding insert and v2 binding projection. It does not widen scopes or add a private MCP profile. |
| Code canonical record/version | `importActiveMemoryRecord` | Owns an immediate transaction and inserts the record, version, exact codebase facet, transition, and FTS row atomically. Replay verifies the stored facet. |
| Harness canonical record/version | `importActiveHarnessMemoryRecord` | Owns an immediate transaction and inserts the record, version, transition, FTS row, and required v2 companion atomically. Losslessly invertible broad kinds receive the exact frozen harness subtype facet; an ambiguous legacy `constraint` receives a `subtype_ambiguous` quarantine row instead. Replay verifies the stored facet or quarantine without guessing. |
| Candidate aggregate | `insertMemoryCandidate` | Owns an immediate transaction (a savepoint when nested under receipt intake) and writes the candidate, required facet or quarantine, receipt link, transition, and outbox effect atomically. Its existing unique producer/client identity plus digest provide replay identity; replay verifies the companion. |
| Candidate lifecycle | `validateMemoryCandidate`, `markMemoryCandidateValidationFailed`, `markMemoryCandidateActive`, `rejectMemoryCandidateByReview` | These update the existing aggregate and transitions only; candidate creation already requires its immutable facet. Activation/reconciliation paths assert that required candidate and record facets still exist before returning or advancing. |
| Receipt aggregate | `acceptMemoryRunReceipt` | Owns an immediate aggregate transaction for receipt, receipt facet, idempotency, embedded candidates and their facet-or-quarantine companions, embedded feedback and feedback facets, links, signals, and outbox effects. Replay recursively verifies all required companions. |
| Receipt result refresh | `refreshMemoryReceiptResult` | Updates the stored result for an existing receipt; the receipt and all linked candidate/feedback facets must already exist. It is not an aggregate-creation path. |
| Standalone feedback | `appendMemoryFeedback` | Owns an immediate transaction for feedback, exact facet, review signals, and outbox effects. Its existing producer/pack/record/revision identity plus digest provide replay identity; both replay paths verify rather than repair the facet. |
| Activation/reconciliation | `activateReviewedMemoryCandidate`, `reconcileVerifiedGithubState` | Reuse the canonical record/candidate lifecycle services and assert the immutable v2 facets for the candidate and active record. No independent v2 record writer exists. |
| Offline legacy import | `applyMemoryLegacyMigration` | Owns the offline transaction, reconciles v2 resources first, adds receipt/candidate facets only when an exact code or harness producer authority is provable, quarantines ambiguous harness subtypes, authority mismatches, missing resources, and unsupported org-plane aggregates, and verifies active-record companions. Replay verifies companions without repair. |

No asynchronous projection job, CDC stream, secondary authority, content-space writer, or policy-domain
writer was added. `registerMemoryV2Resource` accepts only an existing repository or harness authority
row; unavailable content/org resource types are rejected before a write.

## Cutover and reconciliation evidence

- The local migration-ledger audit found no applied migrations `012`–`018` in the discoverable
  workspace databases before numbering was frozen.
- A recoverable pre-Slice-1 local database backup was taken before applying the additive migration
  path. Production deployment must repeat the ledger, traffic/metrics, stopped-writer, backup, and
  reconciliation checks against the actual target; this local artifact is not evidence about a
  production database.
- Migrations `012` and `013` reconcile resource identities, exact source bindings, facets,
  quarantine rows, foreign keys, and active pointers before writers reopen. Ambiguous or
  unsupported rows are quarantined and unavailable to v2 rather than guessed.
- Injected companion failures cover repository, harness, token, record/version/transition,
  receipt/candidate/idempotency/outbox, direct candidate, feedback/signal/outbox, and offline
  legacy-import rollback. Replay-deletion tests prove that missing companions fail closed and are
  not silently recreated.

The unrelated legacy-retention assertion documented during validation is not part of these writer
changes and remains intentionally untouched pending separate approval.
