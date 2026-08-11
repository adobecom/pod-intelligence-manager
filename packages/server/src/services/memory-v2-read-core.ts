import {
  canonicalJsonSha256,
  MemoryContractValidationError,
  parseMemoryContractV2,
  type MemoryRecordV2,
  type MemoryRetrievalPackV2,
  type MemoryScopeV2,
  type MemorySearchResultV2,
  type ResourceBindingV2,
} from "@pim/shared";
import db from "../db/connection.js";
import { memoryV2RecordIsEligible } from "./memory-v2-trust.js";

const V2_SEARCH_OPERATION = "memory_search_v2";
const IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type MemoryV2ReadPlane = "codebase" | "harness";

export type MemoryV2ReadErrorCode =
  | "authentication_required"
  | "scope_required"
  | "resource_binding_mismatch"
  | "resource_not_found"
  | "schema_invalid"
  | "idempotency_conflict"
  | "temporarily_unavailable";

export type MemoryV2ReadErrorDetails = Array<{ path: string; reason: string }>;

export class MemoryV2ReadCoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: MemoryV2ReadErrorCode,
    readonly details: MemoryV2ReadErrorDetails = [],
  ) {
    super(message);
    this.name = "MemoryV2ReadCoreError";
  }
}

export type MemoryV2ReadErrorFactory = (
  message: string,
  statusCode: number,
  code: MemoryV2ReadErrorCode,
  details?: MemoryV2ReadErrorDetails,
) => MemoryV2ReadCoreError;

export interface MemoryV2StoredPackRow {
  retrieval_pack_id: string;
  schema_version: string;
  org_id: string;
  project_id: string;
  request_id: string;
  request_digest: string;
  principal_id: string;
  plane: MemoryV2ReadPlane;
  resource_row_id: string;
  resource_binding_json: string;
  scope_snapshot_digest: string;
  policy_version: string;
  ranker_version: string;
  budget_json: string;
  authorized_scopes_json: string;
  response_json: string;
  token_count: number;
  omitted_count: number;
  created_at: string;
  expires_at: string;
}

export interface MemoryV2StoredPackItemRow {
  item_order: number;
  record_id: string;
  record_version: number;
  token_count: number;
  rank_score: number;
  match_reasons_json: string;
}

export interface MemoryV2ReadRecordIdentity {
  recordId: string;
  recordVersion: number;
  contentDigest: string;
}

export interface MemoryV2ReadScope {
  orgId: string;
  projectId: string;
  plane: MemoryV2ReadPlane;
  resourceRowId: string;
}

export function memoryV2SearchRequestDigest(input: {
  request: unknown;
  principalId: string;
  resourceRowId: string;
}): string {
  return canonicalJsonSha256({
    request: input.request,
    authenticated_principal_id: input.principalId,
    effective_resource_row_id: input.resourceRowId,
  });
}

export function filterMemoryV2EligibleReadRecords<T>(input: {
  records: readonly T[];
  scope: MemoryV2ReadScope;
  now: string;
  identify(record: T): MemoryV2ReadRecordIdentity;
}): T[] {
  return input.records.filter((record) => {
    const identity = input.identify(record);
    return memoryV2RecordIsEligible({
      recordId: identity.recordId,
      recordVersion: identity.recordVersion,
      orgId: input.scope.orgId,
      projectId: input.scope.projectId,
      plane: input.scope.plane,
      resourceRowId: input.scope.resourceRowId,
      now: input.now,
    });
  });
}

export function assertMemoryV2ReadVersionsStable<T>(input: {
  selected: readonly T[];
  current: readonly T[];
  scope: MemoryV2ReadScope;
  now: string;
  identify(record: T): MemoryV2ReadRecordIdentity;
  error: MemoryV2ReadErrorFactory;
}): T[] {
  const current = new Map(filterMemoryV2EligibleReadRecords({
    records: input.current,
    scope: input.scope,
    now: input.now,
    identify: input.identify,
  }).map((record) => {
    const identity = input.identify(record);
    return [`${identity.recordId}:${identity.recordVersion}`, record] as const;
  }));
  return input.selected.map((selected) => {
    const selectedIdentity = input.identify(selected);
    const currentRecord = current.get(
      `${selectedIdentity.recordId}:${selectedIdentity.recordVersion}`,
    );
    if (!currentRecord
        || input.identify(currentRecord).contentDigest !== selectedIdentity.contentDigest) {
      throw input.error(
        "Canonical record eligibility changed during search",
        503,
        "temporarily_unavailable",
      );
    }
    return currentRecord;
  });
}

export function buildMemoryV2SearchResult<T extends { matchReasons: readonly string[] }>(input: {
  requestId: string;
  retrievalPackId: string;
  orgId: string;
  projectId: string;
  plane: MemoryV2ReadPlane;
  resourceBinding: ResourceBindingV2;
  scopeSnapshotDigest: string;
  policyVersion: string;
  rankerVersion: string;
  tokenCount: number;
  items: readonly T[];
  projectRecord(item: T): MemoryRecordV2;
  omittedCount: number;
  expiresAt: string;
  error: MemoryV2ReadErrorFactory;
}): MemorySearchResultV2 {
  try {
    return parseMemoryContractV2("MemorySearchResultV2", {
      schema_version: "pim.memory-search-result.v2",
      request_id: input.requestId,
      retrieval_pack_id: input.retrievalPackId,
      tenant: {
        organization_id: input.orgId,
        project_id: input.projectId,
      },
      plane: input.plane,
      resource_binding: structuredClone(input.resourceBinding),
      scope_snapshot_digest: input.scopeSnapshotDigest,
      policy_version: input.policyVersion,
      ranker_version: input.rankerVersion,
      token_count: input.tokenCount,
      items: input.items.map((item) => {
        const record = input.projectRecord(item);
        return {
          record_id: record.record_id,
          record_version: record.record_version,
          tenant: record.tenant,
          plane: record.plane,
          resource_binding: record.resource_binding,
          kind: record.kind,
          subkind: record.subkind,
          summary: record.content.summary,
          lifecycle: record.lifecycle,
          applicability: record.applicability,
          exceptions: record.exceptions,
          compatibility: record.compatibility,
          validation: record.validation,
          evidence_summary: record.evidence_summary,
          freshness: record.freshness,
          detail_href: `/api/v2/memory/records/${encodeURIComponent(record.record_id)}?version=${record.record_version}`,
          match_reasons: [...item.matchReasons],
        };
      }),
      omitted_count: input.omittedCount,
      expires_at: input.expiresAt,
    });
  } catch (error) {
    if (error instanceof MemoryV2ReadCoreError) throw error;
    throw input.error(
      "Canonical search result cannot be represented by the v2 contract",
      503,
      "temporarily_unavailable",
      error instanceof MemoryContractValidationError ? error.issues : [],
    );
  }
}

function storedPackItems(packId: string): MemoryV2StoredPackItemRow[] {
  return db.prepare(
    `SELECT item_order, record_id, record_version, token_count, rank_score,
            match_reasons_json
     FROM memory_v2_retrieval_pack_items
     WHERE retrieval_pack_id = ? ORDER BY item_order`,
  ).all(packId) as unknown as MemoryV2StoredPackItemRow[];
}

function parseStoredPack(input: {
  row: MemoryV2StoredPackRow;
  items: readonly MemoryV2StoredPackItemRow[];
  error: MemoryV2ReadErrorFactory;
}): MemoryRetrievalPackV2 {
  try {
    const { row, items } = input;
    const result = parseMemoryContractV2("MemorySearchResultV2", JSON.parse(row.response_json));
    const storedBinding = JSON.parse(row.resource_binding_json) as ResourceBindingV2;
    if (result.retrieval_pack_id !== row.retrieval_pack_id
        || result.request_id !== row.request_id
        || result.tenant.organization_id !== row.org_id
        || result.tenant.project_id !== row.project_id
        || result.plane !== row.plane
        || canonicalJsonSha256(result.resource_binding) !== canonicalJsonSha256(storedBinding)
        || result.scope_snapshot_digest !== row.scope_snapshot_digest
        || result.policy_version !== row.policy_version
        || result.ranker_version !== row.ranker_version
        || result.token_count !== row.token_count
        || result.omitted_count !== row.omitted_count
        || result.expires_at !== row.expires_at
        || result.items.length !== items.length
        || result.items.some((item, index) => {
          const stored = items[index];
          return !stored
            || item.record_id !== stored.record_id
            || item.record_version !== stored.record_version
            || canonicalJsonSha256(item.match_reasons)
              !== canonicalJsonSha256(JSON.parse(stored.match_reasons_json));
        })) {
      throw new Error("stored pack response mismatch");
    }
    return parseMemoryContractV2("MemoryRetrievalPackV2", {
      schema_version: row.schema_version,
      retrieval_pack_id: row.retrieval_pack_id,
      request_id: row.request_id,
      request_digest: row.request_digest,
      tenant: { organization_id: row.org_id, project_id: row.project_id },
      plane: row.plane,
      resource_binding: storedBinding,
      scope_snapshot_digest: row.scope_snapshot_digest,
      policy_version: row.policy_version,
      ranker_version: row.ranker_version,
      budget: JSON.parse(row.budget_json),
      authorized_scopes: JSON.parse(row.authorized_scopes_json),
      token_count: row.token_count,
      omitted_count: row.omitted_count,
      items: items.map((item) => ({
        item_order: item.item_order,
        record_id: item.record_id,
        record_version: item.record_version,
        token_count: item.token_count,
        rank_score: item.rank_score,
        match_reasons: JSON.parse(item.match_reasons_json),
      })),
      created_at: row.created_at,
      expires_at: row.expires_at,
    });
  } catch (error) {
    if (error instanceof MemoryV2ReadCoreError) throw error;
    throw input.error(
      "Stored v2 retrieval pack is unavailable",
      503,
      "temporarily_unavailable",
    );
  }
}

export function replayMemoryV2Search(input: {
  orgId: string;
  projectId: string;
  principalId: string;
  requestId: string;
  requestDigest: string;
  plane: MemoryV2ReadPlane;
  resourceBinding: ResourceBindingV2;
  scopeSnapshotDigest: string;
  assertItems(
    row: MemoryV2StoredPackRow,
    items: readonly MemoryV2StoredPackItemRow[],
  ): void;
  error: MemoryV2ReadErrorFactory;
}): MemorySearchResultV2 | null {
  const claim = db.prepare(
    `SELECT request_digest, response_resource_type, response_resource_id, response_json
     FROM memory_idempotency_keys
     WHERE org_id = ? AND project_id = ?
       AND operation = ? AND idempotency_key = ?`,
  ).get(
    input.orgId,
    input.projectId,
    V2_SEARCH_OPERATION,
    input.requestId,
  ) as {
    request_digest: string;
    response_resource_type: string;
    response_resource_id: string;
    response_json: string;
  } | undefined;
  if (!claim) {
    const orphan = db.prepare(
      `SELECT plane FROM memory_v2_retrieval_packs
       WHERE org_id = ? AND project_id = ? AND request_id = ?`,
    ).get(input.orgId, input.projectId, input.requestId) as { plane: string } | undefined;
    if (!orphan) return null;
    if (orphan.plane !== input.plane) {
      throw input.error(
        "Search request_id is already assigned to another plane",
        409,
        "idempotency_conflict",
      );
    }
    throw input.error(
      "Stored v2 search idempotency state is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  if (claim.request_digest !== input.requestDigest) {
    throw input.error(
      "Search request_id was reused with different content",
      409,
      "idempotency_conflict",
    );
  }
  if (claim.response_resource_type !== "memory_v2_retrieval_pack") {
    throw input.error(
      "Stored v2 search idempotency state is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  const row = db.prepare(
    `SELECT * FROM memory_v2_retrieval_packs
     WHERE retrieval_pack_id = ? AND org_id = ? AND project_id = ?`,
  ).get(
    claim.response_resource_id,
    input.orgId,
    input.projectId,
  ) as unknown as MemoryV2StoredPackRow | undefined;
  if (!row
      || row.request_id !== input.requestId
      || row.request_digest !== input.requestDigest
      || row.principal_id !== input.principalId
      || row.plane !== input.plane
      || row.resource_row_id !== input.resourceBinding.resource_row_id) {
    throw input.error(
      "Stored v2 search idempotency state is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  try {
    const items = storedPackItems(row.retrieval_pack_id);
    input.assertItems(row, items);
    const storedPack = parseStoredPack({ row, items, error: input.error });
    if (storedPack.scope_snapshot_digest !== input.scopeSnapshotDigest
        || canonicalJsonSha256(storedPack.resource_binding)
          !== canonicalJsonSha256(input.resourceBinding)) {
      throw input.error(
        "Authenticated memory scope changed since the original search",
        403,
        "resource_binding_mismatch",
      );
    }
    const packResponse = parseMemoryContractV2(
      "MemorySearchResultV2",
      JSON.parse(row.response_json),
    );
    const claimResponse = parseMemoryContractV2(
      "MemorySearchResultV2",
      JSON.parse(claim.response_json),
    );
    if (canonicalJsonSha256(claimResponse) !== canonicalJsonSha256(packResponse)) {
      throw input.error(
        "Stored v2 search idempotency state is incomplete",
        503,
        "temporarily_unavailable",
      );
    }
    return packResponse;
  } catch (error) {
    if (error instanceof MemoryV2ReadCoreError) throw error;
    throw input.error(
      "Stored v2 search replay is unavailable",
      503,
      "temporarily_unavailable",
    );
  }
}

export function persistMemoryV2SearchPack<T extends {
  tokenCount: number;
  rankScore: number;
  matchReasons: readonly string[];
}>(input: {
  request: { request_id: string; budget: { max_tokens: number; max_items: number } };
  principalId: string;
  scope: MemoryV2ReadScope;
  resourceBinding: ResourceBindingV2;
  scopeSnapshotDigest: string;
  authorizedScopes: readonly MemoryScopeV2[];
  context: {
    retrievalPackId: string;
    requestDigest: string;
    policyVersion: string;
    rankerVersion: string;
    items: readonly T[];
    createdAt: string;
    expiresAt: string;
  };
  result: MemorySearchResultV2;
  identify(item: T): MemoryV2ReadRecordIdentity;
}): void {
  const { context, scope } = input;
  db.prepare(
    `INSERT INTO memory_v2_retrieval_packs
       (retrieval_pack_id, schema_version, org_id, project_id, request_id,
        request_digest, principal_id, plane, resource_row_id, resource_binding_json,
        scope_snapshot_digest, policy_version, ranker_version, budget_json,
        authorized_scopes_json, response_json,
        token_count, omitted_count, created_at, expires_at)
     VALUES (?, 'pim.memory-retrieval-pack.v2', ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    context.retrievalPackId,
    scope.orgId,
    scope.projectId,
    input.request.request_id,
    context.requestDigest,
    input.principalId,
    scope.plane,
    scope.resourceRowId,
    JSON.stringify(input.resourceBinding),
    input.scopeSnapshotDigest,
    context.policyVersion,
    context.rankerVersion,
    JSON.stringify(input.request.budget),
    JSON.stringify(input.authorizedScopes),
    JSON.stringify(input.result),
    input.result.token_count,
    input.result.omitted_count,
    context.createdAt,
    context.expiresAt,
  );
  const insertItem = db.prepare(
    `INSERT INTO memory_v2_retrieval_pack_items
       (retrieval_pack_id, item_order, record_id, record_version, token_count,
        rank_score, match_reasons_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  context.items.forEach((item, index) => {
    const identity = input.identify(item);
    insertItem.run(
      context.retrievalPackId,
      index,
      identity.recordId,
      identity.recordVersion,
      item.tokenCount,
      item.rankScore,
      JSON.stringify(item.matchReasons),
    );
  });
  db.prepare(
    `INSERT INTO memory_idempotency_keys
       (org_id, project_id, operation, idempotency_key, request_digest,
        response_resource_type, response_resource_id, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'memory_v2_retrieval_pack', ?, ?, ?, ?)`,
  ).run(
    scope.orgId,
    scope.projectId,
    V2_SEARCH_OPERATION,
    input.request.request_id,
    context.requestDigest,
    context.retrievalPackId,
    JSON.stringify(input.result),
    context.createdAt,
    new Date(Date.parse(context.createdAt) + IDEMPOTENCY_RETENTION_MS).toISOString(),
  );
}

export function readAuthorizedMemoryV2Pack(input: {
  packId: string;
  orgId: string;
  projectId: string;
  plane: MemoryV2ReadPlane;
  resourceRowId: string;
  now: string;
  assertItems(
    row: MemoryV2StoredPackRow,
    items: readonly MemoryV2StoredPackItemRow[],
  ): void;
  error: MemoryV2ReadErrorFactory;
}): MemoryRetrievalPackV2 {
  const row = db.prepare(
    `SELECT * FROM memory_v2_retrieval_packs
     WHERE retrieval_pack_id = ? AND org_id = ? AND project_id = ? AND plane = ?`,
  ).get(
    input.packId,
    input.orgId,
    input.projectId,
    input.plane,
  ) as unknown as MemoryV2StoredPackRow | undefined;
  const nowMs = Date.parse(input.now);
  if (!row || !Number.isFinite(nowMs) || Date.parse(row.expires_at) <= nowMs
      || row.resource_row_id !== input.resourceRowId) {
    throw input.error("Memory retrieval pack is unavailable", 404, "resource_not_found");
  }
  const items = storedPackItems(row.retrieval_pack_id);
  input.assertItems(row, items);
  return parseStoredPack({ row, items, error: input.error });
}
