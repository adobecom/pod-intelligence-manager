import type { DatabaseSync } from "node:sqlite";
import { canonicalizeJson, type ResourceBindingV2 } from "@pim/shared";
import db from "../db/connection.js";
import { getHarnessMemoryRecord } from "./memory-harness-records.js";
import {
  assertMemoryV2StoredRecordFacet,
  type MemoryV2HarnessSubtype,
} from "./memory-v2-canonical-writes.js";
import {
  losslessMemoryV2SubtypeForLegacyKind,
  type MemoryV2BroadKind,
  type MemoryV2Subtype,
} from "./memory-v2-constants.js";
import { assertMemoryV1HarnessRecordRepresentableV2 } from "./memory-v2-harness-read.js";
import { memoryV2HarnessSourceRowId } from "./memory-v2-resources.js";

interface HarnessSourceRow {
  record_id: string;
  record_version: number;
  org_id: string;
  project_id: string;
  harness_id: string;
  kind: MemoryV2BroadKind;
  current_version: number;
  current_status: string;
  valid_from: string;
  valid_until: string | null;
  expires_at: string | null;
  applicability_json: string;
  content_digest: string;
  recorded_at: string;
}

interface HarnessFacetRow {
  org_id: string;
  project_id: string;
  plane: string;
  resource_row_id: string;
  broad_kind: string;
  subtype: string | null;
  projection_status: string;
  facet_json: string;
  created_at: string;
}

interface HarnessResourceRow {
  resource_row_id: string;
  org_id: string;
  project_id: string;
  plane: string;
  resource_type: string;
  canonical_resource_id: string;
  display_label: string;
  provider: string | null;
  provider_resource_id: string | null;
  classification: "public" | "internal" | "confidential" | "restricted";
  valid_until: string | null;
  source_authority: string;
  source_row_id: string;
}

interface HarnessQuarantineRow {
  org_id: string;
  project_id: string;
  source_plane: string;
  reason_code: string;
  source_digest: string;
  created_at: string;
}

export interface MemoryV2HarnessReadFacetReconciliation {
  sourceRecordVersionCount: number;
  mappedRecordVersionCount: number;
  quarantinedRecordVersionCount: number;
  ambiguousRecordVersionCount: number;
  legacyEligibleRecordVersionCount: number;
  serveableRecordVersionCount: number;
  quarantinedLegacyEligibleRecordVersionCount: number;
  representabilityMismatchCount: number;
  companionCountMismatch: number;
  mismatchCount: number;
  emptyBackfill: boolean;
  ok: boolean;
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function count(database: DatabaseSync, sql: string): number {
  return Number((database.prepare(sql).get() as { count: number }).count);
}

function isLegacyEligible(row: HarnessSourceRow, now: string): boolean {
  return row.record_version === row.current_version
    && row.current_status === "active"
    && row.valid_from <= now
    && (row.valid_until === null || row.valid_until > now)
    && (row.expires_at === null || row.expires_at > now);
}

function expectedFacetJson(native: boolean): string {
  return canonicalizeJson(native
    ? {
        projection: "v2_native",
        source_plane: "harness",
        projection_reason: "native_subtype",
      }
    : {
        projection: "v1",
        source_plane: "harness",
        projection_reason: "lossless",
      });
}

function exactResource(
  database: DatabaseSync,
  source: HarnessSourceRow,
): HarnessResourceRow | null {
  return (database.prepare(
    `SELECT resource_row_id, org_id, project_id, plane, resource_type,
            canonical_resource_id, display_label, provider, provider_resource_id,
            classification, valid_until, source_authority, source_row_id
     FROM memory_v2_resources
     WHERE org_id = ? AND project_id = ?
       AND plane = 'harness' AND resource_type = 'harness'
       AND canonical_resource_id = ? AND valid_until IS NULL
       AND source_authority = 'memory_harness_principal_bindings'
       AND source_row_id = ?
       AND display_label = canonical_resource_id
       AND provider IS NULL AND provider_resource_id IS NULL
       AND EXISTS (
         SELECT 1 FROM memory_harness_principal_bindings AS binding
         WHERE binding.org_id = memory_v2_resources.org_id
           AND binding.project_id = memory_v2_resources.project_id
           AND binding.harness_id = memory_v2_resources.canonical_resource_id
       )`,
  ).get(
    source.org_id,
    source.project_id,
    source.harness_id,
    memoryV2HarnessSourceRowId({
      orgId: source.org_id,
      projectId: source.project_id,
      harnessId: source.harness_id,
    }),
  ) as HarnessResourceRow | undefined)
    ?? null;
}

function exactQuarantine(
  row: HarnessQuarantineRow | undefined,
  source: HarnessSourceRow,
  reasonCode: "subtype_ambiguous" | "authority_mismatch" | "resource_missing",
): boolean {
  return row?.org_id === source.org_id
    && row.project_id === source.project_id
    && row.source_plane === "harness"
    && row.reason_code === reasonCode
    && row.source_digest === (source.content_digest || "unavailable").slice(0, 512)
    && row.created_at === source.recorded_at;
}

function resourceBinding(source: HarnessSourceRow, resource: HarnessResourceRow): ResourceBindingV2 {
  return {
    resource_row_id: resource.resource_row_id,
    organization_id: source.org_id,
    project_id: source.project_id,
    plane: "harness",
    resource_type: "harness",
    canonical_resource_id: source.harness_id,
    provider: null,
    provider_resource_id: null,
    display_label: resource.display_label,
    permitted_operations: ["search", "detail", "history", "pack"],
  };
}

export function reconcileMemoryV2HarnessReadFacets(
  options: { now?: string } = {},
  database: DatabaseSync = db,
): MemoryV2HarnessReadFacetReconciliation {
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new TypeError("now must be a valid ISO timestamp");
  const sources = database.prepare(
    `SELECT record.record_id, version.record_version, record.org_id, record.project_id,
            record.harness_id, record.kind, record.current_version, record.current_status,
            record.valid_from,
            record.valid_until, record.expires_at, version.applicability_json,
            version.content_digest, version.recorded_at
     FROM memory_records AS record
     INNER JOIN memory_record_versions AS version ON version.record_id = record.record_id
     WHERE record.plane = 'harness'
     ORDER BY record.record_id, version.record_version`,
  ).all() as unknown as HarnessSourceRow[];
  const facetCount = count(
    database,
    "SELECT COUNT(*) AS count FROM memory_v2_record_facets WHERE plane = 'harness'",
  );
  const quarantineCount = count(
    database,
    `SELECT COUNT(*) AS count FROM memory_v2_facet_quarantine
     WHERE aggregate_type = 'record' AND source_plane = 'harness'`,
  );
  const companionCountMismatch = Math.abs(sources.length - facetCount - quarantineCount);
  let mappedRecordVersionCount = 0;
  let quarantinedRecordVersionCount = 0;
  let ambiguousRecordVersionCount = 0;
  let legacyEligibleRecordVersionCount = 0;
  let serveableRecordVersionCount = 0;
  let quarantinedLegacyEligibleRecordVersionCount = 0;
  let representabilityMismatchCount = 0;
  let mismatchCount = companionCountMismatch;

  for (const source of sources) {
    const eligible = isLegacyEligible(source, now);
    if (eligible) legacyEligibleRecordVersionCount += 1;
    const facet = database.prepare(
      `SELECT org_id, project_id, plane, resource_row_id, broad_kind, subtype,
              projection_status, facet_json, created_at
       FROM memory_v2_record_facets WHERE record_id = ? AND record_version = ?`,
    ).get(source.record_id, source.record_version) as HarnessFacetRow | undefined;
    const quarantine = database.prepare(
      `SELECT org_id, project_id, source_plane, reason_code, source_digest, created_at
       FROM memory_v2_facet_quarantine
       WHERE aggregate_type = 'record' AND aggregate_id = ? AND aggregate_version = ?`,
    ).get(source.record_id, source.record_version) as HarnessQuarantineRow | undefined;
    if (Number(Boolean(facet)) + Number(Boolean(quarantine)) !== 1) {
      mismatchCount += 1;
      continue;
    }

    let subtype = losslessMemoryV2SubtypeForLegacyKind(source.kind);
    let nativeSubtype = false;
    const facetPayload = facet ? parseObject(facet.facet_json) : null;
    if (facet?.subtype
        && facetPayload?.projection === "v2_native"
        && facetPayload.source_plane === "harness"
        && facetPayload.projection_reason === "native_subtype") {
      try {
        // A native subtype is trusted only through the canonical assertion,
        // which closes record provenance over its source candidate, exact v2
        // scope snapshot, and immutable runtime-origin ledger.
        if (database !== db) throw new Error("Native projection requires the live ledger");
        assertMemoryV2StoredRecordFacet({
          recordId: source.record_id,
          recordVersion: source.record_version,
        });
        subtype = facet.subtype as MemoryV2HarnessSubtype;
        nativeSubtype = true;
      } catch {
        mismatchCount += 1;
        continue;
      }
    }
    const applicability = parseObject(source.applicability_json);
    const applicabilityMatches = applicability?.harness_id === source.harness_id;
    const resource = exactResource(database, source);
    const quarantineReason = subtype === null
      ? "subtype_ambiguous" as const
      : !applicabilityMatches
        ? "authority_mismatch" as const
        : resource === null
          ? "resource_missing" as const
          : null;
    if (subtype === null) ambiguousRecordVersionCount += 1;
    if (quarantineReason !== null) {
      if (facet || !exactQuarantine(quarantine, source, quarantineReason)) {
        mismatchCount += 1;
        continue;
      }
      quarantinedRecordVersionCount += 1;
      if (eligible) quarantinedLegacyEligibleRecordVersionCount += 1;
      continue;
    }

    const exactFacet = facet
      && facet.org_id === source.org_id
      && facet.project_id === source.project_id
      && facet.plane === "harness"
      && facet.resource_row_id === resource!.resource_row_id
      && facet.broad_kind === source.kind
      && facet.subtype === subtype
      && facet.projection_status === "mapped"
      && canonicalizeJson(facetPayload) === expectedFacetJson(nativeSubtype)
      && facet.created_at === source.recorded_at;
    if (!exactFacet || quarantine) {
      mismatchCount += 1;
      continue;
    }
    mappedRecordVersionCount += 1;
    try {
      const record = getHarnessMemoryRecord({
        orgId: source.org_id,
        projectId: source.project_id,
        harnessId: source.harness_id,
        recordId: source.record_id,
        recordVersion: source.record_version,
      }, database);
      if (!record) throw new Error("Canonical harness record is unavailable");
      assertMemoryV1HarnessRecordRepresentableV2({
        record,
        organizationId: source.org_id,
        projectId: source.project_id,
        resourceBinding: resourceBinding(source, resource!),
        classification: resource!.classification,
        subtype: subtype as MemoryV2Subtype,
      });
      if (eligible) serveableRecordVersionCount += 1;
    } catch {
      representabilityMismatchCount += 1;
      mismatchCount += 1;
    }
  }

  return {
    sourceRecordVersionCount: sources.length,
    mappedRecordVersionCount,
    quarantinedRecordVersionCount,
    ambiguousRecordVersionCount,
    legacyEligibleRecordVersionCount,
    serveableRecordVersionCount,
    quarantinedLegacyEligibleRecordVersionCount,
    representabilityMismatchCount,
    companionCountMismatch,
    mismatchCount,
    emptyBackfill: sources.length === 0 && facetCount === 0 && quarantineCount === 0,
    ok: mismatchCount === 0,
  };
}

export function assertMemoryV2HarnessServingReady(
  options: { now?: string } = {},
): MemoryV2HarnessReadFacetReconciliation {
  const report = reconcileMemoryV2HarnessReadFacets(options);
  if (!report.ok) {
    throw new Error("Memory v2 harness facet reconciliation failed; harness serving remains closed");
  }
  return report;
}
