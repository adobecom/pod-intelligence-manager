import { canonicalJsonSha256, type ResourceBindingV2 } from "@pim/shared";
import db from "../db/connection.js";
import {
  assertMemoryV2StoredCandidateFacet,
  assertMemoryV2StoredFeedbackFacet,
  assertMemoryV2StoredRecordFacet,
  assertMemoryV2StoredReceiptAggregateFacets,
} from "./memory-v2-canonical-writes.js";
import {
  reconcileMemoryV2Resources,
  getMemoryV2Resource,
  type MemoryV2ResourceReconciliation,
} from "./memory-v2-resources.js";
import { getMemoryRecord } from "./memory-records.js";
import { assertMemoryV1CodeRecordRepresentableV2 } from "./memory-v2-code-read.js";
import { getMemoryCandidateStatus } from "./memory-candidates.js";
import { projectMemoryV1CodeCandidateStatusV2 } from "./memory-v2-code-write.js";
import {
  reconcileMemoryV2HarnessReadFacets,
  type MemoryV2HarnessReadFacetReconciliation,
} from "./memory-v2-harness-facets.js";
import {
  reconcileMemoryV2RuntimeOrigins,
  type MemoryV2RuntimeOriginReconciliation,
} from "./memory-v2-runtime-attestations.js";

export {
  assertMemoryV2HarnessServingReady,
  reconcileMemoryV2HarnessReadFacets,
} from "./memory-v2-harness-facets.js";

type AggregateType = "record" | "candidate" | "receipt" | "feedback";

interface AggregateReconciliation {
  sourceCount: number;
  facetCount: number;
  quarantineCount: number;
  mismatchCount: number;
}

export interface MemoryV2FacetReconciliation {
  records: AggregateReconciliation;
  candidates: AggregateReconciliation;
  receipts: AggregateReconciliation;
  feedback: AggregateReconciliation;
  activePointerCount: number;
  activePointerMismatchCount: number;
  codeReadRecordCount: number;
  codeReadMismatchCount: number;
  codeReadQuarantineCount: number;
  harnessRead: MemoryV2HarnessReadFacetReconciliation;
  foreignKeyViolationCount: number;
  ok: boolean;
}

export interface MemoryV2StartupReconciliation {
  resources: MemoryV2ResourceReconciliation;
  facets: MemoryV2FacetReconciliation;
  writes: MemoryV2WriteReconciliation;
  runtimeOrigins: MemoryV2RuntimeOriginReconciliation;
  reverification: MemoryV2ReverificationReconciliation;
}

export interface MemoryV2ReverificationReconciliation {
  policyCount: number;
  stateCount: number;
  decisionCount: number;
  jobCount: number;
  attemptCount: number;
  influenceRelevantRecordCount: number;
  uncoveredInfluenceRecordCount: number;
  historicalStateCount: number;
  historicalInfluenceEligibleCount: number;
  graphMismatchCount: number;
  digestMismatchCount: number;
  foreignKeyViolationCount: number;
  ok: boolean;
}

export interface MemoryV2WriteReconciliation {
  scopeSnapshotCount: number;
  receiptIdempotencyClaimCount: number;
  feedbackBindingCount: number;
  standaloneFeedbackCount: number;
  receiptFeedbackCount: number;
  feedbackIdempotencyClaimCount: number;
  reviewSignalCount: number;
  reviewOutboxCount: number;
  mismatchCount: number;
  foreignKeyViolationCount: number;
  ok: boolean;
}

interface QuarantineRow {
  org_id: string;
  project_id: string;
  source_plane: string;
  reason_code: string;
  source_digest: string;
  created_at: string;
}

function count(sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

function quarantineRow(
  aggregateType: AggregateType,
  aggregateId: string,
  aggregateVersion: number,
): QuarantineRow | null {
  return (db.prepare(
    `SELECT org_id, project_id, source_plane, reason_code, source_digest, created_at
     FROM memory_v2_facet_quarantine
     WHERE aggregate_type = ? AND aggregate_id = ? AND aggregate_version = ?`,
  ).get(aggregateType, aggregateId, aggregateVersion) as QuarantineRow | undefined) ?? null;
}

function quarantineMatches(
  row: QuarantineRow,
  expected: Omit<QuarantineRow, "reason_code"> & { reasonCodes: readonly string[] },
): boolean {
  return row.org_id === expected.org_id
    && row.project_id === expected.project_id
    && row.source_plane === expected.source_plane
    && expected.reasonCodes.includes(row.reason_code)
    && row.source_digest === expected.source_digest.slice(0, 512)
    && row.created_at === expected.created_at;
}

function companionCounts(
  aggregateType: AggregateType,
  facetTable: string,
): Pick<AggregateReconciliation, "facetCount" | "quarantineCount"> {
  return {
    facetCount: count(`SELECT COUNT(*) AS count FROM ${facetTable}`),
    quarantineCount: count(
      "SELECT COUNT(*) AS count FROM memory_v2_facet_quarantine WHERE aggregate_type = ?",
      aggregateType,
    ),
  };
}

function exactCoverageMismatch(
  sourceCount: number,
  facetCount: number,
  quarantineCount: number,
): number {
  return Math.abs(sourceCount - facetCount - quarantineCount);
}

function reconcileRecords(): AggregateReconciliation {
  const sources = db.prepare(
    `SELECT record.record_id, version.record_version, record.org_id, record.project_id,
            record.plane, record.kind, record.harness_id, version.applicability_json,
            version.content_digest, version.recorded_at
     FROM memory_records AS record
     INNER JOIN memory_record_versions AS version ON version.record_id = record.record_id`,
  ).all() as unknown as Array<{
    record_id: string;
    record_version: number;
    org_id: string;
    project_id: string;
    plane: string;
    kind: string;
    harness_id: string | null;
    applicability_json: string;
    content_digest: string;
    recorded_at: string;
  }>;
  let mismatchCount = 0;
  for (const source of sources) {
    const facet = db.prepare(
      `SELECT created_at FROM memory_v2_record_facets
       WHERE record_id = ? AND record_version = ?`,
    ).get(source.record_id, source.record_version) as { created_at: string } | undefined;
    const quarantine = quarantineRow("record", source.record_id, source.record_version);
    if (Number(Boolean(facet)) + Number(Boolean(quarantine)) !== 1) {
      mismatchCount += 1;
      continue;
    }
    if (facet) {
      try {
        assertMemoryV2StoredRecordFacet({
          recordId: source.record_id,
          recordVersion: source.record_version,
        });
        if (facet.created_at !== source.recorded_at) mismatchCount += 1;
      } catch {
        mismatchCount += 1;
      }
      continue;
    }
    const sourcePlane = ["codebase", "harness", "org"].includes(source.plane)
      ? source.plane
      : "unknown";
    let reasonCodes: readonly string[] = sourcePlane === "org"
      ? ["unsupported_plane"]
      : ["resource_missing"];
    if (sourcePlane === "harness" && source.kind === "constraint") {
      reasonCodes = ["subtype_ambiguous"];
    } else if (sourcePlane === "harness") {
      const applicability = parseObject(source.applicability_json);
      if (applicability?.harness_id !== source.harness_id) {
        reasonCodes = ["authority_mismatch"];
      }
    }
    if (!quarantineMatches(quarantine!, {
      org_id: source.org_id,
      project_id: source.project_id,
      source_plane: sourcePlane,
      reasonCodes,
      source_digest: source.content_digest || "unavailable",
      created_at: source.recorded_at,
    })) mismatchCount += 1;
  }
  const counts = companionCounts("record", "memory_v2_record_facets");
  mismatchCount += exactCoverageMismatch(sources.length, counts.facetCount, counts.quarantineCount);
  return { sourceCount: sources.length, ...counts, mismatchCount };
}

function reconcileCandidates(): AggregateReconciliation {
  const sources = db.prepare(
    `SELECT candidate_id, org_id, project_id, plane, kind, producer_harness_id,
            candidate_digest, created_at,
            CASE WHEN json_valid(candidate_json)
              THEN json_extract(candidate_json, '$.applicability.harness_id')
              ELSE NULL END AS target_harness_id
     FROM memory_candidates_v1`,
  ).all() as unknown as Array<{
    candidate_id: string;
    org_id: string;
    project_id: string;
    plane: string;
    kind: string;
    producer_harness_id: string;
    candidate_digest: string;
    created_at: string;
    target_harness_id: unknown;
  }>;
  let mismatchCount = 0;
  for (const source of sources) {
    const facet = db.prepare(
      `SELECT created_at, resource_row_id, projection_status
       FROM memory_v2_candidate_facets WHERE candidate_id = ?`,
    ).get(source.candidate_id) as {
      created_at: string;
      resource_row_id: string;
      projection_status: string;
    } | undefined;
    const quarantine = quarantineRow("candidate", source.candidate_id, 0);
    if (Number(Boolean(facet)) + Number(Boolean(quarantine)) !== 1) {
      mismatchCount += 1;
      continue;
    }
    if (facet) {
      try {
        assertMemoryV2StoredCandidateFacet(source.candidate_id);
        const harnessAuthorityMatches = source.plane !== "harness"
          || (typeof source.target_harness_id === "string"
            && source.target_harness_id === source.producer_harness_id);
        if (facet.created_at !== source.created_at || !harnessAuthorityMatches) {
          throw new Error("Canonical candidate facet does not match its authority row");
        }
        if (source.plane === "codebase" && facet.projection_status === "mapped") {
          const status = getMemoryCandidateStatus(
            source.org_id,
            source.project_id,
            source.candidate_id,
          );
          const resource = getMemoryV2Resource(facet.resource_row_id);
          if (!status || !resource) {
            throw new Error("Canonical code candidate status resource is unavailable");
          }
          projectMemoryV1CodeCandidateStatusV2({
            status,
            organizationId: source.org_id,
            projectId: source.project_id,
            resourceBinding: {
              resource_row_id: resource.resourceRowId,
              organization_id: resource.orgId,
              project_id: resource.projectId,
              plane: resource.plane,
              resource_type: resource.resourceType,
              canonical_resource_id: resource.canonicalResourceId,
              provider: resource.provider,
              provider_resource_id: resource.providerResourceId,
              display_label: resource.displayLabel,
              permitted_operations: ["candidate_read"],
            },
          });
        }
      } catch {
        mismatchCount += 1;
      }
      continue;
    }
    const sourcePlane = ["codebase", "harness", "org"].includes(source.plane)
      ? source.plane
      : "unknown";
    const targetHarnessId = typeof source.target_harness_id === "string"
      ? source.target_harness_id
      : null;
    const reasonCodes = sourcePlane === "org"
      ? ["unsupported_plane"]
      : sourcePlane === "harness" && source.kind === "constraint"
        ? ["subtype_ambiguous"]
      : sourcePlane === "harness"
          && targetHarnessId !== null
          && targetHarnessId !== source.producer_harness_id
        ? ["authority_mismatch"]
        : ["resource_missing"];
    if (!quarantineMatches(quarantine!, {
      org_id: source.org_id,
      project_id: source.project_id,
      source_plane: sourcePlane,
      reasonCodes,
      source_digest: source.candidate_digest || "unavailable",
      created_at: source.created_at,
    })) mismatchCount += 1;
  }
  const counts = companionCounts("candidate", "memory_v2_candidate_facets");
  mismatchCount += exactCoverageMismatch(sources.length, counts.facetCount, counts.quarantineCount);
  return { sourceCount: sources.length, ...counts, mismatchCount };
}

function reconcileReceipts(): AggregateReconciliation {
  const sources = db.prepare(
    `SELECT receipt_id, org_id, project_id, repository_row_id, producer_harness_id,
            request_digest, created_at
     FROM memory_run_receipts`,
  ).all() as unknown as Array<{
    receipt_id: string;
    org_id: string;
    project_id: string;
    repository_row_id: string | null;
    producer_harness_id: string;
    request_digest: string;
    created_at: string;
  }>;
  let mismatchCount = 0;
  for (const source of sources) {
    const candidates = db.prepare(
      `SELECT candidate.plane, candidate.producer_harness_id,
              CASE WHEN json_valid(candidate.candidate_json)
                THEN json_extract(candidate.candidate_json, '$.applicability.harness_id')
                ELSE NULL END AS target_harness_id
       FROM memory_receipt_candidates AS link
       INNER JOIN memory_candidates_v1 AS candidate ON candidate.candidate_id = link.candidate_id
       WHERE link.receipt_id = ?`,
    ).all(source.receipt_id) as unknown as Array<{
      plane: string;
      producer_harness_id: string;
      target_harness_id: unknown;
    }>;
    const facet = db.prepare(
      "SELECT created_at FROM memory_v2_receipt_facets WHERE receipt_id = ?",
    ).get(source.receipt_id) as { created_at: string } | undefined;
    const quarantine = quarantineRow("receipt", source.receipt_id, 0);
    if (Number(Boolean(facet)) + Number(Boolean(quarantine)) !== 1) {
      mismatchCount += 1;
      continue;
    }
    if (facet) {
      try {
        assertMemoryV2StoredReceiptAggregateFacets(source.receipt_id);
        const harnessAuthorityMatches = source.repository_row_id !== null
          || candidates.length === 0
          || candidates.every((row) => (
            row.plane === "harness"
            && row.producer_harness_id === source.producer_harness_id
            && typeof row.target_harness_id === "string"
            && row.target_harness_id === source.producer_harness_id
          ));
        if (facet.created_at !== source.created_at || !harnessAuthorityMatches) mismatchCount += 1;
      } catch {
        mismatchCount += 1;
      }
      continue;
    }
    let sourcePlane = "unknown";
    let reasonCodes: readonly string[] = ["plane_ambiguous"];
    if (source.repository_row_id) {
      sourcePlane = "codebase";
      reasonCodes = ["resource_missing"];
    } else if (candidates.length > 0 && candidates.every((row) => row.plane === "harness")) {
      sourcePlane = "harness";
      const authorityMismatch = candidates.some((row) => (
        row.producer_harness_id !== source.producer_harness_id
        || (typeof row.target_harness_id === "string"
          && row.target_harness_id !== source.producer_harness_id)
      ));
      reasonCodes = authorityMismatch ? ["authority_mismatch"] : ["resource_missing"];
    } else if (candidates.length > 0 && candidates.every((row) => row.plane === "org")) {
      sourcePlane = "org";
      reasonCodes = ["unsupported_plane"];
    }
    if (!quarantineMatches(quarantine!, {
      org_id: source.org_id,
      project_id: source.project_id,
      source_plane: sourcePlane,
      reasonCodes,
      source_digest: source.request_digest || "unavailable",
      created_at: source.created_at,
    })) mismatchCount += 1;
  }
  const counts = companionCounts("receipt", "memory_v2_receipt_facets");
  mismatchCount += exactCoverageMismatch(sources.length, counts.facetCount, counts.quarantineCount);
  return { sourceCount: sources.length, ...counts, mismatchCount };
}

function reconcileFeedback(): AggregateReconciliation {
  const sources = db.prepare(
    `SELECT feedback.feedback_id, feedback.org_id, feedback.project_id,
            feedback.feedback_digest, feedback.created_at, pack.plane
     FROM memory_feedback AS feedback
     LEFT JOIN memory_retrieval_packs AS pack
       ON pack.retrieval_pack_id = feedback.retrieval_pack_id`,
  ).all() as unknown as Array<{
    feedback_id: string;
    org_id: string;
    project_id: string;
    feedback_digest: string;
    created_at: string;
    plane: string | null;
  }>;
  let mismatchCount = 0;
  for (const source of sources) {
    const facet = db.prepare(
      "SELECT created_at FROM memory_v2_feedback_facets WHERE feedback_id = ?",
    ).get(source.feedback_id) as { created_at: string } | undefined;
    const quarantine = quarantineRow("feedback", source.feedback_id, 0);
    if (Number(Boolean(facet)) + Number(Boolean(quarantine)) !== 1) {
      mismatchCount += 1;
      continue;
    }
    if (facet) {
      try {
        assertMemoryV2StoredFeedbackFacet(source.feedback_id);
        if (facet.created_at !== source.created_at) mismatchCount += 1;
      } catch {
        mismatchCount += 1;
      }
      continue;
    }
    const implementedPlane = source.plane === "codebase" || source.plane === "harness";
    if (!quarantineMatches(quarantine!, {
      org_id: source.org_id,
      project_id: source.project_id,
      source_plane: implementedPlane ? source.plane! : "unknown",
      reasonCodes: implementedPlane ? ["resource_missing"] : ["plane_ambiguous"],
      source_digest: source.feedback_digest || "unavailable",
      created_at: source.created_at,
    })) mismatchCount += 1;
  }
  const counts = companionCounts("feedback", "memory_v2_feedback_facets");
  mismatchCount += exactCoverageMismatch(sources.length, counts.facetCount, counts.quarantineCount);
  return { sourceCount: sources.length, ...counts, mismatchCount };
}

function reconcileActivePointers(): {
  activePointerCount: number;
  activePointerMismatchCount: number;
} {
  const claims = db.prepare(
    `SELECT claim.org_id, claim.project_id, claim.repository_row_id, claim.plane,
            claim.current_candidate_id, claim.current_record_id, claim.current_record_version,
            candidate.org_id AS candidate_org_id,
            candidate.project_id AS candidate_project_id,
            candidate.repository_row_id AS candidate_repository_row_id,
            candidate.plane AS candidate_plane,
            candidate.current_status AS candidate_status,
            candidate.active_record_id, candidate.active_record_version,
            candidate_facet.resource_row_id AS candidate_resource_row_id,
            record.org_id AS record_org_id, record.project_id AS record_project_id,
            record.repository_row_id AS record_repository_row_id,
            record.plane AS record_plane, record.current_status AS record_status,
            record.current_version AS record_current_version,
            version.record_version AS stored_record_version,
            record_facet.resource_row_id AS record_resource_row_id
     FROM memory_activation_claims AS claim
     LEFT JOIN memory_candidates_v1 AS candidate
       ON candidate.candidate_id = claim.current_candidate_id
     LEFT JOIN memory_v2_candidate_facets AS candidate_facet
       ON candidate_facet.candidate_id = candidate.candidate_id
     LEFT JOIN memory_records AS record ON record.record_id = claim.current_record_id
     LEFT JOIN memory_record_versions AS version
       ON version.record_id = claim.current_record_id
      AND version.record_version = claim.current_record_version
     LEFT JOIN memory_v2_record_facets AS record_facet
       ON record_facet.record_id = version.record_id
      AND record_facet.record_version = version.record_version`,
  ).all() as unknown as Array<Record<string, unknown>>;
  let activePointerCount = 0;
  let activePointerMismatchCount = 0;
  for (const claim of claims) {
    const pointerValues = [
      claim.current_candidate_id,
      claim.current_record_id,
      claim.current_record_version,
    ];
    if (pointerValues.every((value) => value === null)) continue;
    activePointerCount += 1;
    const complete = pointerValues.every((value) => value !== null);
    const exact = complete
      && claim.plane === "codebase"
      && claim.candidate_org_id === claim.org_id
      && claim.candidate_project_id === claim.project_id
      && claim.candidate_repository_row_id === claim.repository_row_id
      && claim.candidate_plane === claim.plane
      && claim.candidate_status === "active"
      && claim.active_record_id === claim.current_record_id
      && claim.active_record_version === claim.current_record_version
      && claim.record_org_id === claim.org_id
      && claim.record_project_id === claim.project_id
      && claim.record_repository_row_id === claim.repository_row_id
      && claim.record_plane === claim.plane
      && claim.record_status === "active"
      && claim.record_current_version === claim.current_record_version
      && claim.stored_record_version === claim.current_record_version
      && typeof claim.candidate_resource_row_id === "string"
      && claim.candidate_resource_row_id === claim.record_resource_row_id;
    if (!exact) activePointerMismatchCount += 1;
  }
  return { activePointerCount, activePointerMismatchCount };
}

function reconcileCodeReadFacets(): {
  codeReadRecordCount: number;
  codeReadMismatchCount: number;
  codeReadQuarantineCount: number;
} {
  const rows = db.prepare(
    `SELECT record.record_id, record.org_id, record.project_id, record.kind,
            version.record_version,
            resource.resource_row_id, resource.canonical_resource_id,
            resource.display_label, resource.provider, resource.provider_resource_id,
            resource.classification,
            facet.record_id AS facet_record_id, facet.org_id AS facet_org_id,
            facet.project_id AS facet_project_id, facet.plane AS facet_plane,
            facet.resource_row_id AS facet_resource_row_id,
            facet.broad_kind AS facet_broad_kind, facet.subtype AS facet_subtype,
            facet.projection_status AS facet_projection_status
     FROM memory_records AS record
     INNER JOIN memory_record_versions AS version ON version.record_id = record.record_id
     LEFT JOIN memory_v2_resources AS resource
       ON resource.source_authority = 'memory_repository_registry'
      AND resource.source_row_id = record.repository_row_id
      AND resource.org_id = record.org_id
      AND resource.project_id = record.project_id
      AND resource.plane = 'codebase'
      AND resource.resource_type = 'repository'
      AND resource.valid_until IS NULL
     LEFT JOIN memory_v2_record_facets AS facet
       ON facet.record_id = record.record_id
      AND facet.record_version = version.record_version
     WHERE record.plane = 'codebase'`,
  ).all() as unknown as Array<{
    record_id: string;
    org_id: string;
    project_id: string;
    kind: string;
    record_version: number;
    resource_row_id: string | null;
    canonical_resource_id: string | null;
    display_label: string | null;
    provider: string | null;
    provider_resource_id: string | null;
    classification: "public" | "internal" | "confidential" | "restricted" | null;
    facet_record_id: string | null;
    facet_org_id: string | null;
    facet_project_id: string | null;
    facet_plane: string | null;
    facet_resource_row_id: string | null;
    facet_broad_kind: string | null;
    facet_subtype: string | null;
    facet_projection_status: string | null;
  }>;
  let codeReadMismatchCount = 0;
  for (const row of rows) {
    const exactFacet = row.resource_row_id !== null
      && row.canonical_resource_id !== null
      && row.display_label !== null
      && row.classification !== null
      && row.facet_record_id === row.record_id
      && row.facet_org_id === row.org_id
      && row.facet_project_id === row.project_id
      && row.facet_plane === "codebase"
      && row.facet_resource_row_id === row.resource_row_id
      && row.facet_broad_kind === row.kind
      && row.facet_subtype === null
      && row.facet_projection_status === "mapped";
    if (!exactFacet) {
      codeReadMismatchCount += 1;
      continue;
    }
    const resourceBinding: ResourceBindingV2 = {
      resource_row_id: row.resource_row_id!,
      organization_id: row.org_id,
      project_id: row.project_id,
      plane: "codebase",
      resource_type: "repository",
      canonical_resource_id: row.canonical_resource_id!,
      provider: row.provider,
      provider_resource_id: row.provider_resource_id,
      display_label: row.display_label!,
      permitted_operations: ["search", "detail", "history", "pack"],
    };
    try {
      const record = getMemoryRecord(
        row.org_id,
        row.project_id,
        row.record_id,
        row.record_version,
      );
      if (!record) throw new Error("Canonical record version is unavailable");
      assertMemoryV1CodeRecordRepresentableV2({
        record,
        organizationId: row.org_id,
        projectId: row.project_id,
        resourceBinding,
        classification: row.classification!,
      });
    } catch {
      codeReadMismatchCount += 1;
    }
  }
  const codeReadQuarantineCount = count(
    `SELECT COUNT(*) AS count
     FROM memory_v2_facet_quarantine
     WHERE aggregate_type = 'record' AND source_plane = 'codebase'`,
  );
  return {
    codeReadRecordCount: rows.length,
    codeReadMismatchCount,
    codeReadQuarantineCount,
  };
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function objectAt(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringsAt(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function hasErasureTombstone(
  database: typeof db,
  resourceClass: "receipt" | "feedback",
  resourceId: string,
): boolean {
  return Boolean(database.prepare(
    `SELECT 1 FROM memory_erasure_tombstones
     WHERE resource_class = ? AND resource_id = ?`,
  ).get(resourceClass, resourceId));
}

interface ScopeSnapshotRow {
  receipt_id: string;
  org_id: string;
  project_id: string;
  plane: "codebase" | "harness";
  resource_row_id: string;
  producer_principal_id: string;
  producer_run_id: string;
  request_digest: string;
  core_request_digest: string;
  scope_snapshot_json: string;
  scope_snapshot_digest: string;
  response_json: string;
  created_at: string;
}

interface FeedbackBindingRow {
  feedback_id: string;
  org_id: string;
  project_id: string;
  receipt_id: string;
  producer_principal_id: string;
  producer_run_id: string;
  feedback_stage: "receipt" | "later";
  feedback_revision: number;
  retrieval_pack_id: string;
  record_id: string;
  record_version: number;
  plane: "codebase" | "harness";
  resource_row_id: string;
  scope_snapshot_digest: string;
  feedback_json: string;
  feedback_digest: string;
  response_json: string;
  created_at: string;
}

interface IdempotencyClaimRow {
  org_id: string;
  project_id: string;
  request_digest: string;
  response_resource_type: string;
  response_resource_id: string;
  response_json: string;
}

function scopeSnapshotSelfMatches(database: typeof db, row: ScopeSnapshotRow): boolean {
  const erased = hasErasureTombstone(database, "receipt", row.receipt_id);
  const snapshot = parseObject(row.scope_snapshot_json);
  const response = parseObject(row.response_json);
  if (!snapshot || !response) return false;
  if (erased) return row.scope_snapshot_json === "{}" && row.response_json === "{}";
  const { scope_snapshot_digest: embeddedDigest, ...digestBody } = snapshot;
  if (embeddedDigest !== row.scope_snapshot_digest
      || canonicalJsonSha256(digestBody) !== row.scope_snapshot_digest
      || snapshot.plane !== row.plane) return false;
  const binding = objectAt(snapshot.resource_binding);
  if (!binding
      || binding.resource_row_id !== row.resource_row_id
      || binding.organization_id !== row.org_id
      || binding.project_id !== row.project_id
      || binding.plane !== row.plane) return false;
  if (row.plane === "codebase") {
    if (snapshot.schema_version !== "pim.memory-scope-snapshot.codebase.v2"
        || typeof snapshot.repository_id !== "string"
        || typeof snapshot.base_sha !== "string") return false;
  } else if (snapshot.schema_version !== "pim.memory-scope-snapshot.harness.v2"
      || typeof snapshot.harness_id !== "string"
      || typeof snapshot.harness_version !== "string"
      || typeof snapshot.workflow_version !== "string"
      || typeof snapshot.adapter_version !== "string"
      || typeof snapshot.configuration_id !== "string"
      || typeof snapshot.configuration_digest !== "string") return false;
  const responseBinding = objectAt(response.resource_binding);
  return response.schema_version === "pim.run-receipt-result.v2"
    && response.receipt_id === row.receipt_id
    && response.producer_run_id === row.producer_run_id
    && response.request_digest === row.request_digest
    && response.plane === row.plane
    && response.scope_snapshot_digest === row.scope_snapshot_digest
    && responseBinding?.resource_row_id === row.resource_row_id
    && Array.isArray(response.candidate_results)
    && response.candidate_results.length <= 64;
}

function scopeSnapshotRelationsMatch(database: typeof db, row: ScopeSnapshotRow): boolean {
  const relation = database.prepare(
    `SELECT receipt.repository_row_id, receipt.repository_id, receipt.base_sha,
            receipt.producer_harness_id, resource.resource_type,
            resource.canonical_resource_id, resource.source_authority,
            resource.source_row_id
     FROM memory_run_receipts AS receipt
     INNER JOIN memory_v2_receipt_facets AS facet
       ON facet.receipt_id = receipt.receipt_id
     INNER JOIN memory_v2_resources AS resource
       ON resource.resource_row_id = facet.resource_row_id
     WHERE receipt.receipt_id = ?
       AND receipt.org_id = ? AND receipt.project_id = ?
       AND receipt.producer_run_id = ? AND receipt.request_digest = ?
       AND receipt.created_at = ?
       AND facet.org_id = ? AND facet.project_id = ?
       AND facet.plane = ? AND facet.resource_row_id = ?
       AND facet.created_at = ?
       AND resource.org_id = ? AND resource.project_id = ?
       AND resource.plane = ?`,
  ).get(
    row.receipt_id,
    row.org_id,
    row.project_id,
    row.producer_run_id,
    row.core_request_digest,
    row.created_at,
    row.org_id,
    row.project_id,
    row.plane,
    row.resource_row_id,
    row.created_at,
    row.org_id,
    row.project_id,
    row.plane,
  ) as {
    repository_row_id: string | null;
    repository_id: string | null;
    base_sha: string | null;
    producer_harness_id: string;
    resource_type: string;
    canonical_resource_id: string;
    source_authority: string;
    source_row_id: string;
  } | undefined;
  if (!relation) return false;
  if (hasErasureTombstone(database, "receipt", row.receipt_id)) return true;
  const snapshot = parseObject(row.scope_snapshot_json);
  if (!snapshot) return false;
  if (row.plane === "codebase") {
    return relation.resource_type === "repository"
      && relation.source_authority === "memory_repository_registry"
      && relation.repository_row_id === relation.source_row_id
      && relation.repository_id === relation.canonical_resource_id
      && snapshot.repository_id === relation.repository_id
      && snapshot.base_sha === relation.base_sha;
  }
  return relation.resource_type === "harness"
    && relation.source_authority === "memory_harness_principal_bindings"
    && relation.repository_row_id === null
    && relation.repository_id === null
    && relation.base_sha === null
    && relation.producer_harness_id === relation.canonical_resource_id
    && snapshot.harness_id === relation.producer_harness_id;
}

function reconcileScopeSnapshots(database: typeof db): {
  scopeSnapshotCount: number;
  receiptIdempotencyClaimCount: number;
  mismatchCount: number;
} {
  const rows = database.prepare(
    "SELECT * FROM memory_v2_scope_snapshots ORDER BY receipt_id",
  ).all() as unknown as ScopeSnapshotRow[];
  const claims = database.prepare(
    `SELECT org_id, project_id, request_digest, response_resource_type,
            response_resource_id, response_json
     FROM memory_idempotency_keys
     WHERE operation = 'memory_run_receipt_v2'
     ORDER BY org_id, project_id, idempotency_key`,
  ).all() as unknown as IdempotencyClaimRow[];
  let mismatchCount = Math.abs(rows.length - claims.length);
  for (const row of rows) {
    if (!scopeSnapshotSelfMatches(database, row)
        || !scopeSnapshotRelationsMatch(database, row)) {
      mismatchCount += 1;
    }
    const matchingClaims = claims.filter((claim) =>
      claim.org_id === row.org_id
      && claim.project_id === row.project_id
      && claim.request_digest === row.request_digest
      && claim.response_resource_type === "memory_v2_scope_snapshot"
      && claim.response_resource_id === row.receipt_id
      && claim.response_json === row.response_json);
    if (matchingClaims.length !== 1) mismatchCount += 1;
  }
  for (const claim of claims) {
    if (!rows.some((row) =>
      row.org_id === claim.org_id
      && row.project_id === claim.project_id
      && row.request_digest === claim.request_digest
      && claim.response_resource_type === "memory_v2_scope_snapshot"
      && claim.response_resource_id === row.receipt_id
      && claim.response_json === row.response_json)) mismatchCount += 1;
  }
  return {
    scopeSnapshotCount: rows.length,
    receiptIdempotencyClaimCount: claims.length,
    mismatchCount,
  };
}

function feedbackPayloadMatches(row: FeedbackBindingRow): {
  matches: boolean;
  disposition: string | null;
  reasonCode: string | null;
} {
  const feedback = parseObject(row.feedback_json);
  if (!feedback || canonicalJsonSha256(feedback) !== row.feedback_digest) {
    return { matches: false, disposition: null, reasonCode: null };
  }
  const commonMatches = feedback.retrieval_pack_id === row.retrieval_pack_id
    && feedback.record_id === row.record_id
    && feedback.record_version === row.record_version
    && feedback.scope_snapshot_digest === row.scope_snapshot_digest
    && typeof feedback.disposition === "string"
    && typeof feedback.reason_code === "string";
  if (!commonMatches) return { matches: false, disposition: null, reasonCode: null };
  const stageMatches = row.feedback_stage === "receipt"
    ? row.feedback_revision === 0 && Object.keys(feedback).length === 6
    : row.feedback_revision >= 1
      && feedback.schema_version === "pim.memory-feedback.v2"
      && feedback.feedback_revision === row.feedback_revision
      && feedback.producer_run_id === row.producer_run_id
      && feedback.plane === row.plane
      && feedback.resource_row_id === row.resource_row_id
      && Array.isArray(feedback.outcome_evidence_refs)
      && typeof feedback.event_time === "string"
      && Object.keys(feedback).length === 13;
  return {
    matches: stageMatches,
    disposition: feedback.disposition as string,
    reasonCode: feedback.reason_code as string,
  };
}

function feedbackRelationsMatch(database: typeof db, row: FeedbackBindingRow): boolean {
  return Boolean(database.prepare(
    `SELECT 1
     FROM memory_v2_retrieval_packs AS pack
     INNER JOIN memory_v2_retrieval_pack_items AS item
       ON item.retrieval_pack_id = pack.retrieval_pack_id
     INNER JOIN memory_v2_scope_snapshots AS snapshot
       ON snapshot.receipt_id = ?
     INNER JOIN memory_run_receipts AS receipt
       ON receipt.receipt_id = snapshot.receipt_id
     WHERE pack.retrieval_pack_id = ?
       AND pack.org_id = ? AND pack.project_id = ?
       AND pack.principal_id = ?
       AND pack.plane = ? AND pack.resource_row_id = ?
       AND pack.scope_snapshot_digest = ?
       AND item.record_id = ? AND item.record_version = ?
       AND snapshot.org_id = ? AND snapshot.project_id = ?
       AND snapshot.producer_principal_id = ?
       AND snapshot.producer_run_id = ?
       AND snapshot.plane = ? AND snapshot.resource_row_id = ?
       AND receipt.org_id = ? AND receipt.project_id = ?
       AND receipt.producer_run_id = ?`,
  ).get(
    row.receipt_id,
    row.retrieval_pack_id,
    row.org_id,
    row.project_id,
    row.producer_principal_id,
    row.plane,
    row.resource_row_id,
    row.scope_snapshot_digest,
    row.record_id,
    row.record_version,
    row.org_id,
    row.project_id,
    row.producer_principal_id,
    row.producer_run_id,
    row.plane,
    row.resource_row_id,
    row.org_id,
    row.project_id,
    row.producer_run_id,
  ));
}

function expectedFeedbackSignalTypes(disposition: string | null): string[] {
  if (disposition === "harmful") return ["harmful_review"];
  if (disposition === "stale") return ["checkout_anchor_revalidation", "stale_review"];
  return [];
}

function reconcileFeedbackBindings(database: typeof db): {
  feedbackBindingCount: number;
  standaloneFeedbackCount: number;
  receiptFeedbackCount: number;
  feedbackIdempotencyClaimCount: number;
  reviewSignalCount: number;
  reviewOutboxCount: number;
  mismatchCount: number;
} {
  const rows = database.prepare(
    "SELECT * FROM memory_v2_feedback_bindings ORDER BY feedback_id",
  ).all() as unknown as FeedbackBindingRow[];
  const claims = database.prepare(
    `SELECT org_id, project_id, request_digest, response_resource_type,
            response_resource_id, response_json
     FROM memory_idempotency_keys
     WHERE operation = 'memory_feedback_v2'
     ORDER BY org_id, project_id, idempotency_key`,
  ).all() as unknown as IdempotencyClaimRow[];
  const standaloneFeedbackCount = rows.filter((row) => row.feedback_stage === "later").length;
  const receiptFeedbackCount = rows.length - standaloneFeedbackCount;
  const reviewSignalCount = Number((database.prepare(
    "SELECT COUNT(*) AS count FROM memory_v2_feedback_review_signals",
  ).get() as { count: number }).count);
  const reviewOutboxCount = Number((database.prepare(
    `SELECT COUNT(DISTINCT job.job_id) AS count
     FROM memory_v2_feedback_review_signals AS signal
     INNER JOIN memory_outbox AS job ON job.job_id = signal.outbox_job_id`,
  ).get() as { count: number }).count);
  let mismatchCount = Math.abs(standaloneFeedbackCount - claims.length);
  for (const row of rows) {
    const payload = feedbackPayloadMatches(row);
    if (!payload.matches || !feedbackRelationsMatch(database, row)) mismatchCount += 1;
    const signals = database.prepare(
      `SELECT signal_id, org_id, project_id, feedback_id, record_id, record_version,
              signal_type, reason_code, status, outbox_job_id
       FROM memory_v2_feedback_review_signals
       WHERE feedback_id = ? ORDER BY signal_type`,
    ).all(row.feedback_id) as unknown as Array<{
      signal_id: string;
      org_id: string;
      project_id: string;
      feedback_id: string;
      record_id: string;
      record_version: number;
      signal_type: string;
      reason_code: string;
      status: string;
      outbox_job_id: string;
    }>;
    // Receipt-stage feedback preserves the existing receipt acknowledgement
    // semantics: it is bound atomically, but review signals are only created
    // by the later-feedback workflow.
    const expectedTypes = row.feedback_stage === "later"
      ? expectedFeedbackSignalTypes(payload.disposition)
      : [];
    if (signals.map((signal) => signal.signal_type).sort().join("\0")
        !== expectedTypes.join("\0")) mismatchCount += 1;
    for (const signal of signals) {
      const job = database.prepare(
        `SELECT org_id, project_id, job_type, aggregate_type, aggregate_id, payload_json
         FROM memory_outbox WHERE job_id = ?`,
      ).get(signal.outbox_job_id) as {
        org_id: string;
        project_id: string;
        job_type: string;
        aggregate_type: string;
        aggregate_id: string;
        payload_json: string;
      } | undefined;
      const jobPayload = job ? parseObject(job.payload_json) : null;
      const expectedJobType = signal.signal_type === "checkout_anchor_revalidation"
        ? "record_revalidation"
        : "review_notification";
      if (signal.org_id !== row.org_id
          || signal.project_id !== row.project_id
          || signal.feedback_id !== row.feedback_id
          || signal.record_id !== row.record_id
          || signal.record_version !== row.record_version
          || signal.reason_code !== payload.reasonCode
          || !job
          || job.org_id !== row.org_id
          || job.project_id !== row.project_id
          || job.job_type !== expectedJobType
          || job.aggregate_type !== "record"
          || job.aggregate_id !== row.record_id
          || jobPayload?.feedback_source !== "memory_v2_feedback_bindings"
          || jobPayload.feedback_id !== row.feedback_id
          || jobPayload.signal_id !== signal.signal_id) mismatchCount += 1;
    }
    if (row.feedback_stage === "later") {
      const response = parseObject(row.response_json);
      const responseBinding = response ? objectAt(response.resource_binding) : null;
      const responseSignalIds = response ? stringsAt(response.review_signal_ids) : null;
      if (!response
          || response.schema_version !== "pim.memory-feedback-result.v2"
          || response.feedback_id !== row.feedback_id
          || response.feedback_revision !== row.feedback_revision
          || objectAt(response.tenant)?.organization_id !== row.org_id
          || objectAt(response.tenant)?.project_id !== row.project_id
          || response.plane !== row.plane
          || responseBinding?.resource_row_id !== row.resource_row_id
          || response.duplicate !== false
          || !responseSignalIds
          || responseSignalIds.slice().sort().join("\0")
            !== signals.map((signal) => signal.signal_id).sort().join("\0")) mismatchCount += 1;
      const matchingClaims = claims.filter((claim) =>
        claim.org_id === row.org_id
        && claim.project_id === row.project_id
        && claim.request_digest === row.feedback_digest
        && claim.response_resource_type === "memory_v2_feedback_binding"
        && claim.response_resource_id === row.feedback_id
        && claim.response_json === row.response_json);
      if (matchingClaims.length !== 1) mismatchCount += 1;
    } else {
      const snapshot = database.prepare(
        "SELECT response_json FROM memory_v2_scope_snapshots WHERE receipt_id = ?",
      ).get(row.receipt_id) as { response_json: string } | undefined;
      if (!snapshot || snapshot.response_json !== row.response_json) mismatchCount += 1;
      if (claims.some((claim) => claim.response_resource_id === row.feedback_id)) mismatchCount += 1;
    }
  }
  for (const claim of claims) {
    if (!rows.some((row) =>
      row.feedback_stage === "later"
      && row.org_id === claim.org_id
      && row.project_id === claim.project_id
      && row.feedback_digest === claim.request_digest
      && claim.response_resource_type === "memory_v2_feedback_binding"
      && claim.response_resource_id === row.feedback_id
      && claim.response_json === row.response_json)) mismatchCount += 1;
  }
  mismatchCount += Math.abs(reviewSignalCount - reviewOutboxCount);
  return {
    feedbackBindingCount: rows.length,
    standaloneFeedbackCount,
    receiptFeedbackCount,
    feedbackIdempotencyClaimCount: claims.length,
    reviewSignalCount,
    reviewOutboxCount,
    mismatchCount,
  };
}

export function reconcileMemoryV2CanonicalWrites(database: typeof db = db): MemoryV2WriteReconciliation {
  const scope = reconcileScopeSnapshots(database);
  const feedback = reconcileFeedbackBindings(database);
  const relevantTables = new Set([
    "memory_v2_scope_snapshots",
    "memory_v2_feedback_bindings",
    "memory_v2_feedback_review_signals",
  ]);
  const foreignKeyViolationCount = (database.prepare("PRAGMA foreign_key_check").all() as unknown as Array<{
    table: string;
  }>).filter((row) => relevantTables.has(row.table)).length;
  const mismatchCount = scope.mismatchCount + feedback.mismatchCount;
  return {
    scopeSnapshotCount: scope.scopeSnapshotCount,
    receiptIdempotencyClaimCount: scope.receiptIdempotencyClaimCount,
    feedbackBindingCount: feedback.feedbackBindingCount,
    standaloneFeedbackCount: feedback.standaloneFeedbackCount,
    receiptFeedbackCount: feedback.receiptFeedbackCount,
    feedbackIdempotencyClaimCount: feedback.feedbackIdempotencyClaimCount,
    reviewSignalCount: feedback.reviewSignalCount,
    reviewOutboxCount: feedback.reviewOutboxCount,
    mismatchCount,
    foreignKeyViolationCount,
    ok: mismatchCount === 0 && foreignKeyViolationCount === 0,
  };
}

export function reconcileMemoryV2CanonicalFacets(): MemoryV2FacetReconciliation {
  const records = reconcileRecords();
  const candidates = reconcileCandidates();
  const receipts = reconcileReceipts();
  const feedback = reconcileFeedback();
  const activePointers = reconcileActivePointers();
  const codeRead = reconcileCodeReadFacets();
  const harnessRead = reconcileMemoryV2HarnessReadFacets();
  const relevantTables = new Set([
    "memory_v2_record_facets",
    "memory_v2_candidate_facets",
    "memory_v2_receipt_facets",
    "memory_v2_feedback_facets",
    "memory_v2_facet_quarantine",
  ]);
  const foreignKeyViolationCount = (db.prepare("PRAGMA foreign_key_check").all() as unknown as Array<{
    table: string;
  }>).filter((row) => relevantTables.has(row.table)).length;
  const ok = records.mismatchCount === 0
    && candidates.mismatchCount === 0
    && receipts.mismatchCount === 0
    && feedback.mismatchCount === 0
    && activePointers.activePointerMismatchCount === 0
    && codeRead.codeReadMismatchCount === 0
    && codeRead.codeReadQuarantineCount === 0
    && harnessRead.ok
    && foreignKeyViolationCount === 0;
  return {
    records,
    candidates,
    receipts,
    feedback,
    ...activePointers,
    ...codeRead,
    harnessRead,
    foreignKeyViolationCount,
    ok,
  };
}

interface ReverificationPolicyDigestRow {
  policy_id: string;
  record_id: string;
  record_version: number;
  org_id: string;
  project_id: string;
  plane: "codebase" | "harness";
  resource_row_id: string;
  resolver_type: "github" | "runtime_attestation";
  policy_revision: number;
  interval_seconds: number;
  max_age_seconds: number;
  max_attempts: number;
  active: number;
  policy_digest: string;
}

interface ReverificationDecisionDigestRow {
  decision_id: string;
  job_id: string;
  record_id: string;
  record_version: number;
  policy_revision: number;
  attempt_number: number | null;
  expected_state_version: number;
  committed_state_version: number;
  from_status: string;
  to_status: string;
  provider_outcome: string;
  reason_code: string;
  evidence_digest: string | null;
  source_occurred_at: string | null;
  canonical_from_status: string;
  canonical_to_status: string;
  attempted_at: string;
  decision_digest: string;
}

function reconciliationCount(
  database: typeof db,
  sql: string,
): number {
  return Number((database.prepare(sql).get() as { count: number }).count);
}

/**
 * Verifies the complete additive-017 graph without authoring policy defaults.
 * Every active mapped canonical row needs exact trust. Only evidence-verified
 * rows may have a policy/state pair; legacy-cutover trust is intentionally not
 * enrolled by startup reconciliation.
 */
export function reconcileMemoryV2Reverification(
  database: typeof db = db,
): MemoryV2ReverificationReconciliation {
  const policyCount = reconciliationCount(
    database,
    "SELECT COUNT(*) AS count FROM memory_v2_reverification_policies",
  );
  const stateCount = reconciliationCount(
    database,
    "SELECT COUNT(*) AS count FROM memory_v2_reverification_state",
  );
  const decisionCount = reconciliationCount(
    database,
    "SELECT COUNT(*) AS count FROM memory_v2_reverification_decisions",
  );
  const jobCount = reconciliationCount(
    database,
    "SELECT COUNT(*) AS count FROM memory_v2_reverification_jobs",
  );
  const attemptCount = reconciliationCount(
    database,
    "SELECT COUNT(*) AS count FROM memory_v2_reverification_job_attempts",
  );

  const trustGraphMismatchCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_v2_record_trust AS trust
    LEFT JOIN memory_records AS record
      ON record.record_id = trust.record_id
    LEFT JOIN memory_v2_record_facets AS facet
      ON facet.record_id = trust.record_id
     AND facet.record_version = trust.record_version
    LEFT JOIN memory_v2_resources AS resource
      ON resource.resource_row_id = trust.resource_row_id
    WHERE record.record_id IS NULL
       OR record.org_id <> trust.org_id
       OR record.project_id <> trust.project_id
       OR record.plane <> trust.plane
       OR record.current_version < trust.record_version
       OR facet.record_id IS NULL
       OR facet.org_id <> trust.org_id
       OR facet.project_id <> trust.project_id
       OR facet.plane <> trust.plane
       OR facet.resource_row_id <> trust.resource_row_id
       OR facet.projection_status <> 'mapped'
       OR resource.resource_row_id IS NULL
       OR resource.org_id <> trust.org_id
       OR resource.project_id <> trust.project_id
       OR resource.plane <> trust.plane
  `);
  const policyGraphMismatchCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_v2_reverification_policies AS policy
    LEFT JOIN memory_v2_record_facets AS facet
      ON facet.record_id = policy.record_id
     AND facet.record_version = policy.record_version
    LEFT JOIN memory_v2_resources AS resource
      ON resource.resource_row_id = policy.resource_row_id
    LEFT JOIN memory_records AS record
      ON record.record_id = policy.record_id
    LEFT JOIN memory_v2_record_trust AS trust
      ON trust.record_id = policy.record_id
     AND trust.record_version = policy.record_version
    WHERE facet.record_id IS NULL
       OR facet.org_id <> policy.org_id
       OR facet.project_id <> policy.project_id
       OR facet.plane <> policy.plane
       OR facet.resource_row_id <> policy.resource_row_id
       OR facet.projection_status <> 'mapped'
       OR resource.resource_row_id IS NULL
       OR resource.org_id <> policy.org_id
       OR resource.project_id <> policy.project_id
       OR resource.plane <> policy.plane
       OR (policy.plane = 'codebase' AND policy.resolver_type <> 'github')
       OR (policy.plane = 'harness' AND policy.resolver_type <> 'runtime_attestation')
       OR record.record_id IS NULL
       OR record.org_id <> policy.org_id
       OR record.project_id <> policy.project_id
       OR record.plane <> policy.plane
       OR record.current_version < policy.record_version
       OR trust.record_id IS NULL
       OR trust.org_id <> policy.org_id
       OR trust.project_id <> policy.project_id
       OR trust.plane <> policy.plane
       OR trust.resource_row_id <> policy.resource_row_id
       OR trust.trust_basis <> 'evidence_verified'
  `);
  const stateGraphMismatchCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_v2_reverification_state AS state
    LEFT JOIN memory_v2_reverification_policies AS policy
      ON policy.policy_id = state.policy_id
    LEFT JOIN memory_v2_record_facets AS facet
      ON facet.record_id = state.record_id
     AND facet.record_version = state.record_version
    LEFT JOIN memory_records AS record
      ON record.record_id = state.record_id
    LEFT JOIN memory_v2_resources AS resource
      ON resource.resource_row_id = state.resource_row_id
    LEFT JOIN memory_v2_reverification_decisions AS decision
      ON decision.decision_id = state.latest_decision_id
    WHERE policy.policy_id IS NULL
       OR policy.record_id <> state.record_id
       OR policy.record_version <> state.record_version
       OR policy.org_id <> state.org_id
       OR policy.project_id <> state.project_id
       OR policy.plane <> state.plane
       OR policy.resource_row_id <> state.resource_row_id
       OR policy.policy_revision <> state.policy_revision
       OR facet.record_id IS NULL
       OR facet.org_id <> state.org_id
       OR facet.project_id <> state.project_id
       OR facet.plane <> state.plane
       OR facet.resource_row_id <> state.resource_row_id
       OR facet.projection_status <> 'mapped'
       OR record.record_id IS NULL
       OR record.org_id <> state.org_id
       OR record.project_id <> state.project_id
       OR record.plane <> state.plane
       OR resource.resource_row_id IS NULL
       OR resource.org_id <> state.org_id
       OR resource.project_id <> state.project_id
       OR resource.plane <> state.plane
       OR (record.current_version = state.record_version
         AND record.current_status = 'active'
         AND resource.valid_until IS NOT NULL)
       OR (record.current_version = state.record_version
         AND state.influence_eligible = 1 AND (
           state.status NOT IN ('fresh','due','pending')
           OR policy.active <> 1
           OR record.current_status <> 'active'
         ))
       OR (record.current_version = state.record_version
         AND state.status IN ('fresh','due','pending')
         AND (
           record.current_status <> 'active'
           OR policy.active <> 1
           OR state.influence_eligible <> 1
         ))
       OR (record.current_version = state.record_version
         AND state.status IN ('contradicted','withdrawn')
         AND record.current_status <> 'revoked'
         AND NOT (
           record.current_status IN ('stale','superseded','revoked','expired')
           AND state.last_error_code = 'canonical_lifecycle_' || record.current_status
         ))
       OR (record.current_version = state.record_version
         AND state.status = 'expired' AND record.current_status <> 'expired')
       OR (state.latest_decision_id IS NOT NULL AND (
         decision.decision_id IS NULL
         OR decision.record_id <> state.record_id
         OR decision.record_version <> state.record_version
         OR decision.committed_state_version > state.state_version
         OR decision.policy_revision > state.policy_revision
       ))
  `);
  const decisionGraphMismatchCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_v2_reverification_decisions AS decision
    LEFT JOIN memory_v2_reverification_jobs AS job
      ON job.job_id = decision.job_id
    LEFT JOIN memory_v2_reverification_policies AS policy
      ON policy.policy_id = decision.policy_id
    LEFT JOIN memory_v2_reverification_job_attempts AS attempt
      ON attempt.job_id = decision.job_id
     AND attempt.started_at = decision.attempted_at
     AND attempt.completed_at = decision.decided_at
    WHERE job.job_id IS NULL
       OR policy.policy_id IS NULL
       OR job.record_id <> decision.record_id
       OR job.record_version <> decision.record_version
       OR job.org_id <> decision.org_id
       OR job.project_id <> decision.project_id
       OR job.plane <> decision.plane
       OR job.resource_row_id <> decision.resource_row_id
       OR job.policy_id <> decision.policy_id
       OR job.policy_revision <> decision.policy_revision
       OR policy.record_id <> decision.record_id
       OR policy.record_version <> decision.record_version
       OR policy.org_id <> decision.org_id
       OR policy.project_id <> decision.project_id
       OR policy.plane <> decision.plane
       OR policy.resource_row_id <> decision.resource_row_id
       OR decision.committed_state_version <> decision.expected_state_version + 1
       OR decision.canonical_from_status <> 'active'
       OR decision.from_status NOT IN (
         'fresh','due','pending','contradicted','withdrawn','expired'
       )
       OR decision.to_status NOT IN (
         'fresh','due','pending','contradicted','withdrawn','expired'
       )
       OR NOT (
         (decision.provider_outcome = 'verified'
           AND decision.to_status = 'fresh'
           AND decision.canonical_to_status = 'active')
         OR (decision.provider_outcome = 'contradicted'
           AND decision.to_status = 'contradicted'
           AND decision.canonical_to_status = 'revoked')
         OR (decision.provider_outcome = 'withdrawn'
           AND decision.to_status = 'withdrawn'
           AND decision.canonical_to_status = 'revoked')
         OR (decision.provider_outcome = 'expired'
           AND decision.to_status = 'expired'
           AND decision.canonical_to_status = 'expired')
         OR (decision.provider_outcome = 'unavailable'
           AND decision.to_status = 'pending'
           AND decision.canonical_to_status = 'active')
       )
       OR attempt.attempt_id IS NULL
  `);
  const jobGraphMismatchCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_v2_reverification_jobs AS job
    LEFT JOIN memory_v2_reverification_state AS state
      ON state.record_id = job.record_id
     AND state.record_version = job.record_version
    LEFT JOIN memory_v2_reverification_policies AS policy
      ON policy.policy_id = job.policy_id
    WHERE state.record_id IS NULL
       OR policy.policy_id IS NULL
       OR state.org_id <> job.org_id
       OR state.project_id <> job.project_id
       OR state.plane <> job.plane
       OR state.resource_row_id <> job.resource_row_id
       OR policy.record_id <> job.record_id
       OR policy.record_version <> job.record_version
       OR policy.org_id <> job.org_id
       OR policy.project_id <> job.project_id
       OR policy.plane <> job.plane
       OR policy.resource_row_id <> job.resource_row_id
       OR policy.policy_revision <> job.policy_revision
       OR (job.status IN ('pending','leased') AND (
         state.policy_id <> job.policy_id
         OR state.policy_revision <> job.policy_revision
         OR state.state_version <> job.expected_state_version
       ))
       OR (job.status IN ('completed','dead_letter')
         AND state.state_version < job.expected_state_version)
  `);
  const attemptGraphMismatchCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_v2_reverification_job_attempts AS attempt
    LEFT JOIN memory_v2_reverification_jobs AS job
      ON job.job_id = attempt.job_id
    WHERE job.job_id IS NULL
       OR attempt.attempt_number > job.attempt_count
  `);
  const graphMismatchCount = trustGraphMismatchCount
    + policyGraphMismatchCount
    + stateGraphMismatchCount
    + decisionGraphMismatchCount
    + jobGraphMismatchCount
    + attemptGraphMismatchCount;

  const policies = database.prepare(
    "SELECT * FROM memory_v2_reverification_policies ORDER BY policy_id",
  ).all() as unknown as ReverificationPolicyDigestRow[];
  let digestMismatchCount = 0;
  for (const policy of policies) {
    const expected = canonicalJsonSha256({
      schema_version: "pim.memory-v2-reverification-policy.v1",
      record_id: policy.record_id,
      record_version: policy.record_version,
      org_id: policy.org_id,
      project_id: policy.project_id,
      plane: policy.plane,
      resource_row_id: policy.resource_row_id,
      resolver_type: policy.resolver_type,
      policy_revision: policy.policy_revision,
      interval_seconds: policy.interval_seconds,
      max_age_seconds: policy.max_age_seconds,
      max_attempts: policy.max_attempts,
      active: policy.active === 1,
    });
    if (policy.policy_digest !== expected
        || policy.policy_id !== `reverify_policy_${expected.slice("sha256:".length, 47)}`) {
      digestMismatchCount += 1;
    }
  }
  const decisions = database.prepare(
    `SELECT decision.*, attempt.attempt_number
     FROM memory_v2_reverification_decisions AS decision
     LEFT JOIN memory_v2_reverification_job_attempts AS attempt
       ON attempt.job_id = decision.job_id
      AND attempt.started_at = decision.attempted_at
      AND attempt.completed_at = decision.decided_at
     ORDER BY decision.decision_id`,
  ).all() as unknown as ReverificationDecisionDigestRow[];
  for (const decision of decisions) {
    if (decision.attempt_number === null) {
      digestMismatchCount += 1;
      continue;
    }
    const expected = canonicalJsonSha256({
      schema_version: "pim.memory-v2-reverification-decision.v1",
      job_id: decision.job_id,
      record_id: decision.record_id,
      record_version: decision.record_version,
      policy_revision: decision.policy_revision,
      attempt_number: decision.attempt_number,
      expected_state_version: decision.expected_state_version,
      committed_state_version: decision.committed_state_version,
      from_status: decision.from_status,
      to_status: decision.to_status,
      provider_outcome: decision.provider_outcome,
      reason_code: decision.reason_code,
      evidence_digest: decision.evidence_digest,
      source_occurred_at: decision.source_occurred_at,
      canonical_from_status: decision.canonical_from_status,
      canonical_to_status: decision.canonical_to_status,
      attempted_at: decision.attempted_at,
    });
    if (decision.decision_digest !== expected
        || decision.decision_id !== `reverify_decision_${expected.slice("sha256:".length, 47)}`) {
      digestMismatchCount += 1;
    }
  }

  const influenceRelevantRecordCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_records AS record
    JOIN memory_v2_record_facets AS facet
      ON facet.record_id = record.record_id
     AND facet.record_version = record.current_version
    WHERE record.current_status = 'active'
      AND facet.projection_status = 'mapped'
  `);
  const uncoveredInfluenceRecordCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_records AS record
    JOIN memory_v2_record_facets AS facet
      ON facet.record_id = record.record_id
     AND facet.record_version = record.current_version
    WHERE record.current_status = 'active'
      AND facet.projection_status = 'mapped'
      AND NOT EXISTS (
        SELECT 1
        FROM memory_v2_record_trust AS trust
        WHERE trust.record_id = record.record_id
          AND trust.record_version = record.current_version
          AND trust.org_id = record.org_id
          AND trust.project_id = record.project_id
          AND trust.plane = record.plane
          AND trust.resource_row_id = facet.resource_row_id
          AND trust.trust_status = 'trusted'
      )
  `);
  const historicalStateCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_v2_reverification_state AS state
    JOIN memory_records AS record ON record.record_id = state.record_id
    WHERE state.record_version <> record.current_version
  `);
  const historicalInfluenceEligibleCount = reconciliationCount(database, `
    SELECT COUNT(*) AS count
    FROM memory_v2_reverification_state AS state
    JOIN memory_records AS record ON record.record_id = state.record_id
    WHERE state.record_version <> record.current_version
      AND state.influence_eligible = 1
  `);
  const relevantTables = new Set([
    "memory_v2_record_trust",
    "memory_v2_reverification_policies",
    "memory_v2_reverification_state",
    "memory_v2_reverification_decisions",
    "memory_v2_reverification_jobs",
    "memory_v2_reverification_job_attempts",
  ]);
  const foreignKeyViolationCount = (
    database.prepare("PRAGMA foreign_key_check").all() as unknown as Array<{ table: string }>
  ).filter((row) => relevantTables.has(row.table)).length;
  return {
    policyCount,
    stateCount,
    decisionCount,
    jobCount,
    attemptCount,
    influenceRelevantRecordCount,
    uncoveredInfluenceRecordCount,
    historicalStateCount,
    historicalInfluenceEligibleCount,
    graphMismatchCount,
    digestMismatchCount,
    foreignKeyViolationCount,
    ok: uncoveredInfluenceRecordCount === 0
      && graphMismatchCount === 0
      && digestMismatchCount === 0
      && foreignKeyViolationCount === 0,
  };
}

export function assertMemoryV2StartupReconciled(): MemoryV2StartupReconciliation {
  const resources = reconcileMemoryV2Resources();
  const facets = reconcileMemoryV2CanonicalFacets();
  const writes = reconcileMemoryV2CanonicalWrites();
  const runtimeOrigins = reconcileMemoryV2RuntimeOrigins();
  const reverification = reconcileMemoryV2Reverification();
  if (!resources.ok || !facets.ok || !writes.ok || !runtimeOrigins.ok
      || !reverification.ok) {
    throw new Error("Memory v2 startup reconciliation failed; service remains closed");
  }
  return { resources, facets, writes, runtimeOrigins, reverification };
}
