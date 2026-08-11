import {
  canonicalJsonSha256,
  parseMemoryContractV2,
  type HarnessMemorySearchV2,
  type MemoryEvidenceHandleV2,
  type MemoryRecordV2,
  type MemoryRetrievalPackV2,
  type MemoryScopeV2,
  type MemorySearchResultV2,
  type MemoryHarnessSearchV1,
  type ResourceBindingV2,
} from "@pim/shared";
import { authorizeMemoryV2Resource } from "../middleware/service-authz.js";
import db from "../db/connection.js";
import {
  assertMemoryV2StoredRecordFacet,
  type MemoryV2HarnessSubtype,
} from "./memory-v2-canonical-writes.js";
import {
  getMemoryV2Binding,
} from "./memory-v2-binding.js";
import type { MemoryHarnessPrincipalBinding } from "./memory-harness-bindings.js";
import {
  getHarnessMemoryRecord,
  listCurrentHarnessMemoryRecords,
  type HarnessMemoryRecord,
} from "./memory-harness-records.js";
import {
  executeHarnessMemorySearchWithProjection,
  MemoryHarnessSearchError,
  type HarnessMemorySearchDependencies,
  type HarnessMemorySearchProjectionContext,
} from "./memory-harness-search.js";
import type { MemoryV2Resource } from "./memory-v2-resources.js";
import {
  MEMORY_V2_SUBTYPE_KIND,
  type MemoryV2Operation,
} from "./memory-v2-constants.js";
import {
  assertMemoryV2ReadVersionsStable,
  buildMemoryV2SearchResult,
  filterMemoryV2EligibleReadRecords,
  memoryV2SearchRequestDigest,
  MemoryV2ReadCoreError,
  persistMemoryV2SearchPack,
  readAuthorizedMemoryV2Pack,
  replayMemoryV2Search,
  type MemoryV2ReadErrorCode,
  type MemoryV2ReadErrorFactory,
  type MemoryV2StoredPackItemRow,
  type MemoryV2StoredPackRow,
} from "./memory-v2-read-core.js";
import type {
  AuthorizedMemoryV2ResourceContext,
  MemoryV2RequestAuthorizationSnapshot,
} from "./memory-v2-request-authorization.js";

export type MemoryV2HarnessReadErrorCode = MemoryV2ReadErrorCode;

export class MemoryV2HarnessReadError extends MemoryV2ReadCoreError {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: MemoryV2HarnessReadErrorCode,
    readonly details: Array<{ path: string; reason: string }> = [],
  ) {
    super(message, statusCode, code, details);
    this.name = "MemoryV2HarnessReadError";
  }
}

interface EffectiveHarnessBinding {
  authorization: AuthorizedMemoryV2ResourceContext;
  principal: MemoryV2RequestAuthorizationSnapshot;
  resource: MemoryV2Resource;
  resourceBinding: ResourceBindingV2;
  authorizedScopes: MemoryScopeV2[];
  harnessBinding: MemoryHarnessPrincipalBinding;
}

interface StoredFacetRow {
  org_id: string;
  project_id: string;
  plane: "codebase" | "harness";
  resource_row_id: string;
  broad_kind: HarnessMemoryRecord["kind"];
  subtype: MemoryV2HarnessSubtype | null;
  projection_status: "mapped" | "unmappable";
}

function harnessReadError(
  message: string,
  statusCode: number,
  code: MemoryV2HarnessReadErrorCode,
  path?: string,
  reason?: string,
): MemoryV2HarnessReadError {
  return new MemoryV2HarnessReadError(
    message,
    statusCode,
    code,
    path && reason ? [{ path, reason }] : [],
  );
}

const harnessReadCoreError: MemoryV2ReadErrorFactory = (
  message,
  statusCode,
  code,
  details = [],
) => new MemoryV2HarnessReadError(message, statusCode, code, details);

function requireProjectPrincipal(
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined,
  projectId?: string,
): MemoryV2RequestAuthorizationSnapshot {
  if (!principal) {
    throw harnessReadError(
      "A PIM service-token principal is required",
      401,
      "authentication_required",
    );
  }
  if (!principal.projectId || principal.podId || (projectId && principal.projectId !== projectId)) {
    throw harnessReadError(
      "A matching project-bound service token is required",
      403,
      "resource_binding_mismatch",
    );
  }
  return principal;
}

function authorizeOperation(
  principal: MemoryV2RequestAuthorizationSnapshot,
  projectId: string,
  resourceRowId: string,
  operation: MemoryV2Operation,
): Extract<ReturnType<typeof authorizeMemoryV2Resource>, { decision: "allow" }> {
  const decision = authorizeMemoryV2Resource({
    principal,
    operation,
    plane: "harness",
    projectId,
    resourceRowId,
  });
  if (decision.decision === "allow") return decision;
  if (decision.reason === "principal_unavailable") {
    throw harnessReadError(
      "The authenticated service-token principal is no longer available",
      401,
      "authentication_required",
    );
  }
  if (decision.reason === "scope_missing") {
    throw harnessReadError("The required memory scope is unavailable", 403, "scope_required");
  }
  throw harnessReadError(
    "The selected resource is outside the authenticated binding",
    403,
    "resource_binding_mismatch",
  );
}

function effectiveBindingForResource(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  projectId: string;
  resource: MemoryV2Resource;
  operation: MemoryV2Operation;
}): EffectiveHarnessBinding {
  const principal = requireProjectPrincipal(input.principal, input.projectId);
  const authorization = authorizeOperation(
    principal,
    input.projectId,
    input.resource.resourceRowId,
    input.operation,
  );
  const binding = getMemoryV2Binding(principal);
  if (authorization.context.source.kind !== "harness") {
    throw harnessReadError(
      "Authenticated harness source is unavailable",
      503,
      "temporarily_unavailable",
    );
  }
  return {
    authorization: authorization.context,
    principal,
    resource: authorization.context.resource as MemoryV2Resource,
    resourceBinding: {
      ...authorization.context.binding,
      permitted_operations: [...authorization.context.binding.permitted_operations],
    },
    authorizedScopes: binding.scopes,
    harnessBinding: authorization.context.source.harness as MemoryHarnessPrincipalBinding,
  };
}

function effectiveBindingFromAuthorization(
  authorization: AuthorizedMemoryV2ResourceContext,
  operation: MemoryV2Operation,
): EffectiveHarnessBinding {
  if (authorization.operation !== operation
      || authorization.resource.plane !== "harness"
      || authorization.resource.resourceType !== "harness"
      || authorization.source.kind !== "harness"
      || authorization.binding.resource_row_id !== authorization.resource.resourceRowId
      || authorization.binding.project_id !== authorization.principal.projectId) {
    throw harnessReadError(
      "Authorized harness resource context is inconsistent",
      503,
      "temporarily_unavailable",
    );
  }
  return {
    authorization,
    principal: authorization.principal,
    resource: authorization.resource as MemoryV2Resource,
    resourceBinding: {
      ...authorization.binding,
      permitted_operations: [...authorization.binding.permitted_operations],
    },
    authorizedScopes: getMemoryV2Binding(authorization.principal).scopes,
    harnessBinding: authorization.source.harness as MemoryHarnessPrincipalBinding,
  };
}

export function authorizeHarnessMemorySearchV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  request: HarnessMemorySearchV2;
}): AuthorizedMemoryV2ResourceContext {
  const principal = requireProjectPrincipal(input.principal, input.request.tenant.project_id);
  const resource = resolveSearchResource(principal, input.request);
  return effectiveBindingForResource({
    principal,
    projectId: input.request.tenant.project_id,
    resource,
    operation: "search",
  }).authorization;
}

function resolveSearchResource(
  principal: MemoryV2RequestAuthorizationSnapshot,
  request: HarnessMemorySearchV2,
): MemoryV2Resource {
  const selector = request.resource_selector;
  const effectiveResources = principal.resources.filter((item) => (
    item.resource.plane === "harness"
    && item.resource.resourceType === "harness"
    && item.projectId === request.tenant.project_id
  ));
  let selected: typeof effectiveResources[number] | undefined;
  if (selector && "resource_row_id" in selector) {
    selected = effectiveResources.find((item) => item.resourceRowId === selector.resource_row_id);
  } else if (selector && "canonical_resource_id" in selector) {
    selected = effectiveResources.find(
      (item) => item.resource.canonicalResourceId === selector.canonical_resource_id,
    );
  } else {
    selected = effectiveResources.length === 1 ? effectiveResources[0] : undefined;
  }
  if (!selected) {
    throw harnessReadError(
      selector
        ? "Memory harness is unavailable"
        : "An exact harness selector is required for this service token",
      selector ? 404 : 403,
      selector ? "resource_not_found" : "resource_binding_mismatch",
    );
  }
  const resource = selected.resource as MemoryV2Resource;

  if (resource.orgId !== principal.orgId || resource.projectId !== request.tenant.project_id) {
    throw harnessReadError(
      "The selected resource does not match the authenticated tenant",
      403,
      "resource_binding_mismatch",
    );
  }
  if (request.consumer.harness_id !== resource.canonicalResourceId
      || request.applicability.harness_id !== resource.canonicalResourceId) {
    throw harnessReadError(
      "Harness applicability does not match the selected resource",
      403,
      "resource_binding_mismatch",
      "/applicability/harness_id",
      "harness must resolve to the selected resource",
    );
  }
  return resource;
}

function facetRow(recordId: string, recordVersion: number): StoredFacetRow | null {
  return (db.prepare(
    `SELECT org_id, project_id, plane, resource_row_id, broad_kind, subtype,
            projection_status
     FROM memory_v2_record_facets
     WHERE record_id = ? AND record_version = ?`,
  ).get(recordId, recordVersion) as StoredFacetRow | undefined) ?? null;
}

function subtypeQuarantined(recordId: string, recordVersion: number): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM memory_v2_facet_quarantine
     WHERE aggregate_type = 'record' AND aggregate_id = ? AND aggregate_version = ?
       AND source_plane = 'harness' AND reason_code = 'subtype_ambiguous'`,
  ).get(recordId, recordVersion));
}

function mappedHarnessFacet(input: {
  record: HarnessMemoryRecord;
  orgId: string;
  projectId: string;
  resourceRowId: string;
}): StoredFacetRow | null {
  const facet = facetRow(input.record.recordId, input.record.recordVersion);
  const quarantined = subtypeQuarantined(input.record.recordId, input.record.recordVersion);
  if (quarantined) {
    if (facet) {
      throw harnessReadError(
        "Canonical harness facet reconciliation is inconsistent",
        503,
        "temporarily_unavailable",
      );
    }
    return null;
  }
  if (!facet) {
    throw harnessReadError(
      "Canonical harness facet reconciliation is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  if (facet.projection_status === "unmappable") return null;
  if (facet.org_id !== input.orgId
      || facet.project_id !== input.projectId
      || facet.plane !== "harness"
      || facet.resource_row_id !== input.resourceRowId
      || facet.broad_kind !== input.record.kind
      || facet.subtype === null
      || MEMORY_V2_SUBTYPE_KIND[facet.subtype] !== input.record.kind) {
    throw harnessReadError(
      "Canonical harness facet reconciliation is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  try {
    assertMemoryV2StoredRecordFacet({
      recordId: input.record.recordId,
      recordVersion: input.record.recordVersion,
    });
  } catch {
    throw harnessReadError(
      "Canonical harness facet reconciliation is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  return facet;
}

function evidenceType(type: string): MemoryEvidenceHandleV2["type"] | null {
  if (type === "git_diff") return "git_diff";
  if (type === "test" || type === "test_run" || type === "ci_gate") return "test";
  if (type === "failure") return "failure";
  if (type === "runtime_attestation" || type === "github_merge" || type === "github_revert") {
    return "runtime_attestation";
  }
  if (type === "authorized_review" || type === "review" || type === "policy_decision") {
    return "authorized_review";
  }
  return null;
}

function harnessEvidence(record: HarnessMemoryRecord): MemoryEvidenceHandleV2[] {
  return record.evidence.map((item) => {
    const type = evidenceType(item.type);
    if (!type || item.origin_id.length > 256) {
      throw harnessReadError(
        "Canonical harness evidence cannot be represented by the v2 contract",
        503,
        "temporarily_unavailable",
      );
    }
    if (type === "authorized_review" && item.source_authority !== "authorized_review") {
      throw harnessReadError(
        "Canonical harness review evidence lacks authorized-review authority",
        503,
        "temporarily_unavailable",
      );
    }
    return {
      evidence_ref_id: item.evidence_ref_id,
      type,
      digest: item.digest,
      origin_id: item.origin_id,
      source_authority: item.source_authority,
    };
  });
}

function freshnessStatus(record: HarnessMemoryRecord): MemoryRecordV2["freshness"]["status"] {
  if (record.status === "revoked") return "withdrawn";
  if (record.status === "expired") return "expired";
  if (record.status === "stale" || record.status === "superseded") return "stale";
  const expiresAt = record.freshness.expires_at ?? null;
  return expiresAt && Date.parse(expiresAt) <= Date.now() ? "expired" : "fresh";
}

export interface HarnessRecordV2ProjectionInput {
  record: HarnessMemoryRecord;
  organizationId: string;
  projectId: string;
  resourceBinding: ResourceBindingV2;
  classification: MemoryV2Resource["classification"];
  subtype: MemoryV2HarnessSubtype;
}

function nativeConfigurationDigests(record: HarnessMemoryRecord): string[] {
  const value = record.provenance.v2_configuration_digests;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32
      || value.some((item) => typeof item !== "string"
        || !/^sha256:[0-9a-f]{64}$/.test(item))) {
    throw harnessReadError(
      "Native v2 harness configuration provenance is invalid",
      503,
      "temporarily_unavailable",
    );
  }
  return [...new Set(value as string[])];
}

function nativeCorroborationDomainCount(record: HarnessMemoryRecord): number {
  const value = record.provenance.v2_distinct_corroboration_domain_count;
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 128) {
    throw harnessReadError(
      "Native v2 harness corroboration provenance is invalid",
      503,
      "temporarily_unavailable",
    );
  }
  return value;
}

/** Pure canonical-v1 to v2 projection used by search, detail, and startup gating. */
export function projectMemoryV1HarnessRecordV2(
  input: HarnessRecordV2ProjectionInput,
): MemoryRecordV2 {
  if (input.classification === "public"
      || MEMORY_V2_SUBTYPE_KIND[input.subtype] !== input.record.kind
      || !input.record.transitionSummary) {
    throw harnessReadError(
      "Canonical harness record cannot be represented by the v2 contract",
      503,
      "temporarily_unavailable",
    );
  }
  const applicability = input.record.applicability;
  try {
    return parseMemoryContractV2("MemoryRecordV2", {
      schema_version: "pim.memory-record.v2",
      record_id: input.record.recordId,
      record_version: input.record.recordVersion,
      tenant: {
        organization_id: input.organizationId,
        project_id: input.projectId,
      },
      plane: "harness",
      resource_binding: structuredClone(input.resourceBinding),
      kind: input.record.kind,
      subkind: input.subtype,
      content: input.record.content,
      applicability: {
        plane: "harness",
        harness_id: input.record.harnessId,
        harness_version_range: applicability.harness_version_range
          ?? input.record.compatibility.harness_version_range,
        workflow_version_range: applicability.workflow_version_range
          ?? input.record.compatibility.workflow_version_range,
        adapter_version_range: applicability.adapter_version_range
          ?? input.record.compatibility.adapter_version_range
          ?? "*",
        configuration_ids: applicability.configuration_ids ?? [],
        configuration_digests: nativeConfigurationDigests(input.record),
        model_ids: applicability.model_ids ?? [],
        tool_ids: applicability.tool_ids ?? [],
      },
      compatibility: {
        harness_version_range: input.record.compatibility.harness_version_range,
        workflow_version_range: input.record.compatibility.workflow_version_range,
        adapter_version_range: input.record.compatibility.adapter_version_range ?? "*",
      },
      exceptions: input.record.exceptions,
      validation: {
        strategy: input.record.validation.strategy === "policy_owner_review"
          ? "authorized_review"
          : input.record.validation.strategy,
        anchor_refs: [...new Set(
          (input.record.validation.anchor_refs ?? []).map((anchor) => anchor.digest),
        )],
        failure_fingerprint: input.record.validation.failure_fingerprint ?? null,
      },
      evidence: harnessEvidence(input.record),
      evidence_summary: {
        ...input.record.evidenceSummary,
        distinct_corroboration_domain_count: nativeCorroborationDomainCount(input.record),
      },
      freshness: {
        status: freshnessStatus(input.record),
        last_confirmed_at: input.record.freshness.last_confirmed_at,
        last_verified_at: null,
        next_reverify_at: null,
        expires_at: input.record.freshness.expires_at ?? null,
      },
      lifecycle: { status: input.record.status },
      transition_summary: input.record.transitionSummary,
      recorded_at: input.record.recordedAt,
      classification: input.classification,
    });
  } catch (error) {
    if (error instanceof MemoryV2HarnessReadError) throw error;
    throw harnessReadError(
      "Canonical harness record cannot be represented by the v2 contract",
      503,
      "temporarily_unavailable",
    );
  }
}

export function assertMemoryV1HarnessRecordRepresentableV2(
  input: HarnessRecordV2ProjectionInput,
): void {
  projectMemoryV1HarnessRecordV2(input);
}

function projectHarnessRecord(
  record: HarnessMemoryRecord,
  binding: EffectiveHarnessBinding,
): MemoryRecordV2 {
  const facet = mappedHarnessFacet({
    record,
    orgId: binding.principal.orgId,
    projectId: binding.resource.projectId,
    resourceRowId: binding.resource.resourceRowId,
  });
  if (!facet?.subtype) {
    throw harnessReadError(
      "Canonical harness record has an ambiguous subtype",
      503,
      "temporarily_unavailable",
    );
  }
  return projectMemoryV1HarnessRecordV2({
    record,
    organizationId: binding.principal.orgId,
    projectId: binding.resource.projectId,
    resourceBinding: binding.resourceBinding,
    classification: binding.resource.classification,
    subtype: facet.subtype,
  });
}

function scopeDigest(
  binding: EffectiveHarnessBinding,
  request: HarnessMemorySearchV2,
): string {
  return canonicalJsonSha256({
    schema_version: "pim.memory-scope-snapshot.harness.v2",
    plane: "harness",
    resource_binding: binding.resourceBinding,
    harness_id: binding.resource.canonicalResourceId,
    harness_version: request.consumer.harness_version,
    workflow_version: request.consumer.workflow_version,
    adapter_version: request.consumer.adapter_version,
    configuration_ids: request.applicability.configuration_ids,
    configuration_digests: request.applicability.configuration_digests,
    model_ids: request.applicability.model_ids,
    tool_ids: request.applicability.tool_ids,
  });
}

function toV1Search(request: HarnessMemorySearchV2): MemoryHarnessSearchV1 {
  // Outer v2 validation has already bounded every field. This internal request
  // deliberately contains only selectors that current canonical harness rows
  // actually store; configuration digests are handled as an impossible hard
  // filter rather than ignored or copied into a new index.
  return {
    schema_version: "pim.memory-harness-search.v1",
    request_id: request.request_id,
    consumer: request.consumer,
    tenant: request.tenant,
    plane: "harness",
    applicability: {
      harness_id: request.applicability.harness_id,
      harness_version_range: request.applicability.harness_version_range,
      workflow_version_range: request.applicability.workflow_version_range,
      adapter_version_range: request.applicability.adapter_version_range,
      configuration_ids: request.applicability.configuration_ids,
      model_ids: request.applicability.model_ids,
      tool_ids: request.applicability.tool_ids,
    },
    task: request.task,
    temporal: request.temporal,
    budget: request.budget,
    options: request.options,
  } as MemoryHarnessSearchV1;
}

function harnessRecordIdentity(record: HarnessMemoryRecord) {
  return {
    recordId: record.recordId,
    recordVersion: record.recordVersion,
    contentDigest: record.contentDigest,
  };
}

function buildSearchResult(
  request: HarnessMemorySearchV2,
  binding: EffectiveHarnessBinding,
  scopeSnapshotDigest: string,
  context: HarnessMemorySearchProjectionContext,
): MemorySearchResultV2 {
  return buildMemoryV2SearchResult({
    requestId: request.request_id,
    retrievalPackId: context.retrievalPackId,
    orgId: binding.principal.orgId,
    projectId: binding.resource.projectId,
    plane: "harness",
    resourceBinding: binding.resourceBinding,
    scopeSnapshotDigest,
    policyVersion: context.policyVersion,
    rankerVersion: context.rankerVersion,
    tokenCount: context.response.token_count,
    items: context.items,
    projectRecord: (item) => projectHarnessRecord(item.record, binding),
    omittedCount: context.response.omitted_count,
    expiresAt: context.expiresAt,
    error: harnessReadCoreError,
  });
}

function assertStoredPackItems(
  row: MemoryV2StoredPackRow,
  items: readonly MemoryV2StoredPackItemRow[],
): void {
  let harnessId: string;
  try {
    const resource = JSON.parse(row.resource_binding_json) as ResourceBindingV2;
    if (row.plane !== "harness" || resource.plane !== "harness") throw new Error();
    harnessId = resource.canonical_resource_id;
  } catch {
    throw harnessReadError(
      "Stored v2 harness retrieval pack is unavailable",
      503,
      "temporarily_unavailable",
    );
  }
  for (const item of items) {
    const record = getHarnessMemoryRecord({
      orgId: row.org_id,
      projectId: row.project_id,
      harnessId,
      recordId: item.record_id,
      recordVersion: item.record_version,
    });
    if (!record || !mappedHarnessFacet({
      record,
      orgId: row.org_id,
      projectId: row.project_id,
      resourceRowId: row.resource_row_id,
    })) {
      throw harnessReadError(
        "Stored v2 harness retrieval pack item is unavailable",
        503,
        "temporarily_unavailable",
      );
    }
  }
}

function insertV2Pack(input: {
  request: HarnessMemorySearchV2;
  binding: EffectiveHarnessBinding;
  scopeSnapshotDigest: string;
  context: HarnessMemorySearchProjectionContext;
  result: MemorySearchResultV2;
}): void {
  persistMemoryV2SearchPack({
    request: input.request,
    principalId: input.binding.principal.servicePrincipalId,
    scope: {
      orgId: input.binding.principal.orgId,
      projectId: input.binding.resource.projectId,
      plane: "harness",
      resourceRowId: input.binding.resource.resourceRowId,
    },
    resourceBinding: input.binding.resourceBinding,
    scopeSnapshotDigest: input.scopeSnapshotDigest,
    authorizedScopes: input.binding.authorizedScopes,
    context: input.context,
    result: input.result,
    identify: (item) => harnessRecordIdentity(item.record),
  });
}

export interface HarnessMemoryV2SearchDependencies extends HarnessMemorySearchDependencies {}

export async function searchAuthorizedHarnessMemoryV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  request: HarnessMemorySearchV2;
  dependencies?: HarnessMemoryV2SearchDependencies;
}): Promise<MemorySearchResultV2> {
  const binding = effectiveBindingFromAuthorization(input.authorization, "search");
  const principal = binding.principal;
  const resource = binding.resource;
  if (principal.projectId !== input.request.tenant.project_id
      || input.request.consumer.harness_id !== resource.canonicalResourceId
      || input.request.applicability.harness_id !== resource.canonicalResourceId
      || (input.request.resource_selector !== null
        && ("resource_row_id" in input.request.resource_selector
          ? input.request.resource_selector.resource_row_id !== resource.resourceRowId
          : input.request.resource_selector.canonical_resource_id
            !== resource.canonicalResourceId))) {
    throw harnessReadError(
      "The request does not match the authorized harness",
      403,
      "resource_binding_mismatch",
    );
  }
  const normalizedRequest = parseMemoryContractV2("HarnessMemorySearchV2", {
    ...input.request,
    resource_selector: { resource_row_id: resource.resourceRowId },
    applicability: {
      ...input.request.applicability,
      harness_id: resource.canonicalResourceId,
    },
  });
  const requestDigest = memoryV2SearchRequestDigest({
    request: normalizedRequest,
    principalId: principal.servicePrincipalId,
    resourceRowId: resource.resourceRowId,
  });
  const snapshotDigest = scopeDigest(binding, normalizedRequest);
  const v1Request = toV1Search(normalizedRequest);
  const readScope = {
    orgId: principal.orgId,
    projectId: normalizedRequest.tenant.project_id,
    plane: "harness" as const,
    resourceRowId: resource.resourceRowId,
  };

  try {
    return executeHarnessMemorySearchWithProjection({
      orgId: principal.orgId,
      projectId: normalizedRequest.tenant.project_id,
      principalId: principal.servicePrincipalId,
      binding: binding.harnessBinding,
      request: v1Request,
    }, input.dependencies ?? {}, {
      requestDigest,
      replay: () => replayMemoryV2Search({
        orgId: principal.orgId,
        projectId: normalizedRequest.tenant.project_id,
        principalId: principal.servicePrincipalId,
        requestId: normalizedRequest.request_id,
        requestDigest,
        scopeSnapshotDigest: snapshotDigest,
        resourceBinding: binding.resourceBinding,
        plane: "harness",
        assertItems: assertStoredPackItems,
        error: harnessReadCoreError,
      }),
      filterAuthorizedRecords: (records) => {
        const mapped = records.filter((record) => (
          mappedHarnessFacet({
            record,
            orgId: principal.orgId,
            projectId: normalizedRequest.tenant.project_id,
            resourceRowId: resource.resourceRowId,
          }) !== null
        ));
        // Configuration digests are frozen contract fields but have no current
        // canonical selector column. They can narrow only to an empty result.
        return normalizedRequest.applicability.configuration_digests.length > 0
          ? []
          : filterMemoryV2EligibleReadRecords({
              records: mapped,
              scope: readScope,
              now: (input.dependencies?.now?.() ?? new Date()).toISOString(),
              identify: harnessRecordIdentity,
            });
      },
      assertCommitRecords: (selected) => {
        const now = (input.dependencies?.now?.() ?? new Date()).toISOString();
        const current = listCurrentHarnessMemoryRecords({
          orgId: principal.orgId,
          projectId: normalizedRequest.tenant.project_id,
          harnessId: resource.canonicalResourceId,
          now,
        });
        for (const currentRecord of assertMemoryV2ReadVersionsStable({
          selected,
          current,
          scope: readScope,
          now,
          identify: harnessRecordIdentity,
          error: harnessReadCoreError,
        })) {
          mappedHarnessFacet({
            record: currentRecord,
            orgId: principal.orgId,
            projectId: normalizedRequest.tenant.project_id,
            resourceRowId: resource.resourceRowId,
          });
        }
      },
      commit: (context) => {
        const result = buildSearchResult(
          normalizedRequest,
          binding,
          snapshotDigest,
          context,
        );
        insertV2Pack({
          request: normalizedRequest,
          binding,
          scopeSnapshotDigest: snapshotDigest,
          context,
          result,
        });
        return result;
      },
    });
  } catch (error) {
    if (error instanceof MemoryHarnessSearchError) {
      throw harnessReadError(error.message, error.statusCode, error.code);
    }
    throw error;
  }
}

/** In-process composition adapter used by direct callers and focused tests. */
export async function searchHarnessMemoryV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  request: HarnessMemorySearchV2;
  dependencies?: HarnessMemoryV2SearchDependencies;
}): Promise<MemorySearchResultV2> {
  return searchAuthorizedHarnessMemoryV2({
    authorization: authorizeHarnessMemorySearchV2(input),
    request: input.request,
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  });
}

function harnessRecordForPrincipal(input: {
  principal: MemoryV2RequestAuthorizationSnapshot;
  recordId: string;
  recordVersion: number;
}): { record: HarnessMemoryRecord; binding: EffectiveHarnessBinding } {
  const authority = db.prepare(
    `SELECT record.harness_id, facet.resource_row_id
     FROM memory_records AS record
     INNER JOIN memory_record_versions AS version
       ON version.record_id = record.record_id AND version.record_version = ?
     LEFT JOIN memory_v2_record_facets AS facet
       ON facet.record_id = version.record_id AND facet.record_version = version.record_version
     WHERE record.org_id = ? AND record.project_id = ?
       AND record.record_id = ? AND record.plane = 'harness'`,
  ).get(
    input.recordVersion,
    input.principal.orgId,
    input.principal.projectId!,
    input.recordId,
  ) as { harness_id: string; resource_row_id: string | null } | undefined;
  if (!authority) {
    throw harnessReadError("Memory record is unavailable", 404, "resource_not_found");
  }
  if (!authority.resource_row_id) {
    if (subtypeQuarantined(input.recordId, input.recordVersion)) {
      throw harnessReadError(
        "Canonical harness record has an ambiguous subtype",
        503,
        "temporarily_unavailable",
      );
    }
    throw harnessReadError(
      "Canonical harness facet reconciliation is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  const resource = input.principal.resources.find((candidate) => (
    candidate.resourceRowId === authority.resource_row_id
    && candidate.resource.plane === "harness"
    && candidate.resource.resourceType === "harness"
  ))?.resource as MemoryV2Resource | undefined;
  if (!resource) {
    throw harnessReadError("Memory record is unavailable", 404, "resource_not_found");
  }
  const binding = effectiveBindingForResource({
    principal: input.principal,
    projectId: input.principal.projectId!,
    resource,
    operation: "detail",
  });
  if (resource.canonicalResourceId !== authority.harness_id) {
    throw harnessReadError(
      "Canonical harness resource reconciliation is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  const record = getHarnessMemoryRecord({
    orgId: input.principal.orgId,
    projectId: input.principal.projectId!,
    harnessId: authority.harness_id,
    recordId: input.recordId,
    recordVersion: input.recordVersion,
  });
  if (!record) {
    throw harnessReadError("Memory record is unavailable", 404, "resource_not_found");
  }
  return { record, binding };
}

export function getAuthorizedHarnessMemoryRecordV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  recordId: string;
  recordVersion: number;
}): MemoryRecordV2 {
  const binding = effectiveBindingFromAuthorization(input.authorization, "detail");
  const principal = binding.principal;
  const authority = db.prepare(
    `SELECT record.harness_id, facet.resource_row_id
     FROM memory_records AS record
     INNER JOIN memory_record_versions AS version
       ON version.record_id = record.record_id AND version.record_version = ?
     LEFT JOIN memory_v2_record_facets AS facet
       ON facet.record_id = version.record_id AND facet.record_version = version.record_version
     WHERE record.org_id = ? AND record.project_id = ?
       AND record.record_id = ? AND record.plane = 'harness'`,
  ).get(
    input.recordVersion,
    principal.orgId,
    principal.projectId!,
    input.recordId,
  ) as { harness_id: string; resource_row_id: string | null } | undefined;
  if (!authority || authority.resource_row_id !== binding.resource.resourceRowId
      || authority.harness_id !== binding.resource.canonicalResourceId) {
    throw harnessReadError("Memory record is unavailable", 404, "resource_not_found");
  }
  const record = getHarnessMemoryRecord({
    orgId: principal.orgId,
    projectId: principal.projectId!,
    harnessId: authority.harness_id,
    recordId: input.recordId,
    recordVersion: input.recordVersion,
  });
  if (!record) throw harnessReadError("Memory record is unavailable", 404, "resource_not_found");
  return projectHarnessRecord(record, binding);
}

export function getAuthorizedHarnessMemoryPackV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  packId: string;
  now?: string;
}): MemoryRetrievalPackV2 {
  const binding = effectiveBindingFromAuthorization(input.authorization, "pack");
  return readAuthorizedMemoryV2Pack({
    packId: input.packId,
    orgId: binding.principal.orgId,
    projectId: binding.resource.projectId,
    plane: "harness",
    resourceRowId: binding.resource.resourceRowId,
    now: input.now ?? new Date().toISOString(),
    assertItems: assertStoredPackItems,
    error: harnessReadCoreError,
  });
}

export function getHarnessMemoryRecordV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  recordId: string;
  recordVersion: number;
}): MemoryRecordV2 {
  return getAuthorizedHarnessMemoryRecordV2({
    authorization: authorizeHarnessMemoryRecordV2(input),
    recordId: input.recordId,
    recordVersion: input.recordVersion,
  });
}

export function authorizeHarnessMemoryRecordV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  recordId: string;
  recordVersion: number;
}): AuthorizedMemoryV2ResourceContext {
  const principal = requireProjectPrincipal(input.principal);
  const resolved = harnessRecordForPrincipal({
    principal,
    recordId: input.recordId,
    recordVersion: input.recordVersion,
  });
  return resolved.binding.authorization;
}

export function getHarnessMemoryPackV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  packId: string;
  now?: string;
}): MemoryRetrievalPackV2 {
  return getAuthorizedHarnessMemoryPackV2({
    authorization: authorizeHarnessMemoryPackV2(input),
    packId: input.packId,
    ...(input.now ? { now: input.now } : {}),
  });
}

export function authorizeHarnessMemoryPackV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  packId: string;
}): AuthorizedMemoryV2ResourceContext {
  const principal = requireProjectPrincipal(input.principal);
  const row = db.prepare(
    `SELECT resource_row_id FROM memory_v2_retrieval_packs
     WHERE retrieval_pack_id = ? AND org_id = ? AND project_id = ? AND plane = 'harness'`,
  ).get(input.packId, principal.orgId, principal.projectId!) as {
    resource_row_id: string;
  } | undefined;
  if (!row) throw harnessReadError("Memory retrieval pack is unavailable", 404, "resource_not_found");
  const resource = principal.resources.find((candidate) => (
    candidate.resourceRowId === row.resource_row_id
    && candidate.resource.plane === "harness"
    && candidate.resource.resourceType === "harness"
  ))?.resource as MemoryV2Resource | undefined;
  if (!resource) throw harnessReadError("Memory retrieval pack is unavailable", 404, "resource_not_found");
  return effectiveBindingForResource({
    principal,
    projectId: principal.projectId!,
    resource,
    operation: "pack",
  }).authorization;
}
