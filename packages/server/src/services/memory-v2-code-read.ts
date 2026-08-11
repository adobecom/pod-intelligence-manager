import {
  canonicalJsonSha256,
  parseMemoryContract,
  parseMemoryContractV2,
  type CodebaseApplicabilityV1,
  type CodebaseMemorySearchV2,
  type MemoryEvidenceHandleV2,
  type MemoryRecordHistoryV2,
  type MemoryRecordV1,
  type MemoryRecordV2,
  type MemoryRetrievalPackV2,
  type MemoryScopeV2,
  type MemorySearchResultV2,
  type MemorySearchV1,
  type ResourceBindingV2,
} from "@pim/shared";
import { authorizeMemoryV2Resource } from "../middleware/service-authz.js";
import db from "../db/connection.js";
import {
  assertMemoryV2StoredRecordFacet,
  MemoryV2CanonicalWriteError,
} from "./memory-v2-canonical-writes.js";
import { getMemoryV2Binding } from "./memory-v2-binding.js";
import {
  getMemoryRecord,
  getMemoryRecordHistory,
  listAuthorizedCurrentMemoryRecords,
  type SearchableMemoryRecord,
} from "./memory-records.js";
import {
  executeMemorySearchWithProjection,
  MemorySearchIdempotencyError,
  type MemorySearchDependencies,
  type MemorySearchProjectionContext,
} from "./memory-search.js";
import type { MemoryRepositoryBinding } from "./memory-repository-registry.js";
import type { MemoryV2Resource } from "./memory-v2-resources.js";
import type { MemoryV2Operation } from "./memory-v2-constants.js";
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

export type MemoryV2CodeReadErrorCode = MemoryV2ReadErrorCode;

export class MemoryV2CodeReadError extends MemoryV2ReadCoreError {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: MemoryV2CodeReadErrorCode,
    readonly details: Array<{ path: string; reason: string }> = [],
  ) {
    super(message, statusCode, code, details);
    this.name = "MemoryV2CodeReadError";
  }
}

interface EffectiveCodeBinding {
  authorization: AuthorizedMemoryV2ResourceContext;
  principal: MemoryV2RequestAuthorizationSnapshot;
  resource: MemoryV2Resource;
  resourceBinding: ResourceBindingV2;
  authorizedScopes: MemoryScopeV2[];
  repository: MemoryRepositoryBinding;
}

interface StoredFacetRow {
  org_id: string;
  project_id: string;
  plane: "codebase" | "harness";
  resource_row_id: string;
  broad_kind: MemoryRecordV1["kind"];
  subtype: string | null;
  projection_status: "mapped" | "unmappable";
}

function codeReadError(
  message: string,
  statusCode: number,
  code: MemoryV2CodeReadErrorCode,
  path?: string,
  reason?: string,
): MemoryV2CodeReadError {
  return new MemoryV2CodeReadError(
    message,
    statusCode,
    code,
    path && reason ? [{ path, reason }] : [],
  );
}

const codeReadCoreError: MemoryV2ReadErrorFactory = (
  message,
  statusCode,
  code,
  details = [],
) => new MemoryV2CodeReadError(message, statusCode, code, details);

function requireProjectPrincipal(
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined,
  projectId?: string,
): MemoryV2RequestAuthorizationSnapshot {
  if (!principal) {
    throw codeReadError(
      "A PIM service-token principal is required",
      401,
      "authentication_required",
    );
  }
  if (!principal.projectId || principal.podId || (projectId && principal.projectId !== projectId)) {
    throw codeReadError(
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
    plane: "codebase",
    projectId,
    resourceRowId,
  });
  if (decision.decision === "allow") return decision;
  if (decision.reason === "principal_unavailable") {
    throw codeReadError(
      "The authenticated service-token principal is no longer available",
      401,
      "authentication_required",
    );
  }
  if (decision.reason === "scope_missing") {
    throw codeReadError("The required memory scope is unavailable", 403, "scope_required");
  }
  throw codeReadError(
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
}): EffectiveCodeBinding {
  const principal = requireProjectPrincipal(input.principal, input.projectId);
  const authorization = authorizeOperation(
    principal,
    input.projectId,
    input.resource.resourceRowId,
    input.operation,
  );
  if (authorization.context.source.kind !== "repository") {
    throw codeReadError(
      "Authenticated repository source is unavailable",
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
    authorizedScopes: getMemoryV2Binding(principal).scopes,
    repository: authorization.context.source.repository as MemoryRepositoryBinding,
  };
}

function effectiveBindingFromAuthorization(
  authorization: AuthorizedMemoryV2ResourceContext,
  operation: MemoryV2Operation,
): EffectiveCodeBinding {
  if (authorization.operation !== operation
      || authorization.resource.plane !== "codebase"
      || authorization.resource.resourceType !== "repository"
      || authorization.source.kind !== "repository"
      || authorization.binding.resource_row_id !== authorization.resource.resourceRowId
      || authorization.binding.project_id !== authorization.principal.projectId) {
    throw codeReadError(
      "Authorized codebase resource context is inconsistent",
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
    repository: authorization.source.repository as MemoryRepositoryBinding,
  };
}

export function authorizeCodeMemorySearchV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  request: CodebaseMemorySearchV2;
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
  request: CodebaseMemorySearchV2,
): MemoryV2Resource {
  const selector = request.resource_selector;
  const resources = principal.resources.filter((binding) => (
    binding.resource.plane === "codebase"
    && binding.resource.resourceType === "repository"
    && binding.projectId === request.tenant.project_id
    && (!selector
      || ("resource_row_id" in selector
        ? binding.resourceRowId === selector.resource_row_id
        : binding.resource.canonicalResourceId === selector.canonical_resource_id
          || binding.canonicalAliases.includes(selector.canonical_resource_id)))
  ));
  if (resources.length !== 1) {
    throw codeReadError(
      selector
        ? "Memory repository is unavailable"
        : "An exact repository selector is required for this service token",
      selector ? 404 : 403,
      selector ? "resource_not_found" : "resource_binding_mismatch",
      "/resource_selector",
      "selector must resolve exactly one bound repository",
    );
  }
  const selected = resources[0]!;
  const resource = selected.resource as MemoryV2Resource;

  if (resource.orgId !== principal.orgId || resource.projectId !== request.tenant.project_id) {
    throw codeReadError(
      "The selected resource does not match the authenticated tenant",
      403,
      "resource_binding_mismatch",
    );
  }
  if (request.applicability.repository_id !== resource.canonicalResourceId
      && !selected.canonicalAliases.includes(request.applicability.repository_id)) {
    throw codeReadError(
      "Repository applicability does not match the selected resource",
      403,
      "resource_binding_mismatch",
      "/applicability/repository_id",
      "repository must resolve to the selected resource",
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

function assertCodeFacet(input: {
  record: MemoryRecordV1;
  orgId: string;
  projectId: string;
  resourceRowId: string;
}): StoredFacetRow {
  try {
    assertMemoryV2StoredRecordFacet({
      recordId: input.record.record_id,
      recordVersion: input.record.record_version,
    });
  } catch (error) {
    if (!(error instanceof MemoryV2CanonicalWriteError)) throw error;
    throw codeReadError(
      "Canonical memory facet reconciliation is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  const facet = facetRow(input.record.record_id, input.record.record_version);
  if (!facet
      || facet.org_id !== input.orgId
      || facet.project_id !== input.projectId
      || facet.plane !== "codebase"
      || facet.resource_row_id !== input.resourceRowId
      || facet.broad_kind !== input.record.kind
      || facet.subtype !== null
      || facet.projection_status !== "mapped") {
    throw codeReadError(
      "Canonical memory facet reconciliation is incomplete",
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

function codeEvidence(record: MemoryRecordV1): MemoryEvidenceHandleV2[] {
  return record.evidence.map((item) => {
    const type = evidenceType(item.type);
    if (!type || item.origin_id.length > 256) {
      throw codeReadError(
        "Canonical record evidence cannot be represented by the v2 contract",
        503,
        "temporarily_unavailable",
      );
    }
    if (type === "authorized_review" && item.source_authority !== "authorized_review") {
      throw codeReadError(
        "Canonical record review evidence lacks authorized-review authority",
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

function codeValidation(record: MemoryRecordV1): MemoryRecordV2["validation"] {
  const strategy = record.validation.strategy === "policy_owner_review"
    ? "authorized_review"
    : record.validation.strategy;
  return {
    strategy,
    anchor_refs: [...new Set(
      (record.validation.anchor_refs ?? []).map((anchor) => anchor.digest),
    )],
    failure_fingerprint: record.validation.failure_fingerprint ?? null,
  };
}

function freshnessStatus(record: MemoryRecordV1): MemoryRecordV2["freshness"]["status"] {
  if (record.lifecycle.status === "revoked") return "withdrawn";
  if (record.lifecycle.status === "expired") return "expired";
  if (record.lifecycle.status === "stale" || record.lifecycle.status === "superseded") return "stale";
  const expiresAt = record.freshness.expires_at ?? null;
  return expiresAt && Date.parse(expiresAt) <= Date.now() ? "expired" : "fresh";
}

interface CodeRecordV2ProjectionInput {
  record: MemoryRecordV1;
  organizationId: string;
  projectId: string;
  resourceBinding: ResourceBindingV2;
  classification: MemoryV2Resource["classification"];
}

function projectCodeRecordV2(input: CodeRecordV2ProjectionInput): MemoryRecordV2 {
  if (input.classification === "public") {
    throw codeReadError(
      "Canonical record classification cannot be represented by the v2 contract",
      503,
      "temporarily_unavailable",
    );
  }
  const applicability = input.record.applicability as CodebaseApplicabilityV1;
  try {
    return parseMemoryContractV2("MemoryRecordV2", {
      schema_version: "pim.memory-record.v2",
      record_id: input.record.record_id,
      record_version: input.record.record_version,
      tenant: {
        organization_id: input.organizationId,
        project_id: input.projectId,
      },
      plane: "codebase",
      resource_binding: structuredClone(input.resourceBinding),
      kind: input.record.kind,
      subkind: null,
      content: input.record.content,
      applicability: {
        plane: "codebase",
        repository_id: input.resourceBinding.canonical_resource_id,
        base_sha: applicability.base_sha ?? null,
        components: applicability.components ?? [],
        paths: applicability.paths ?? [],
        symbols: applicability.symbols ?? [],
        task_classes: applicability.task_classes ?? [],
      },
      compatibility: {
        harness_version_range: input.record.compatibility.harness_version_range,
        workflow_version_range: input.record.compatibility.workflow_version_range,
        adapter_version_range: input.record.compatibility.adapter_version_range ?? "*",
      },
      exceptions: input.record.exceptions,
      validation: codeValidation(input.record),
      evidence: codeEvidence(input.record),
      evidence_summary: {
        ...input.record.evidence_summary,
        distinct_corroboration_domain_count: 0,
      },
      freshness: {
        status: freshnessStatus(input.record),
        last_confirmed_at: input.record.freshness.last_confirmed_at,
        last_verified_at: null,
        next_reverify_at: null,
        expires_at: input.record.freshness.expires_at ?? null,
      },
      lifecycle: input.record.lifecycle,
      transition_summary: input.record.transition_summary,
      recorded_at: input.record.recorded_at,
      classification: input.classification,
    });
  } catch (error) {
    if (error instanceof MemoryV2CodeReadError) throw error;
    throw codeReadError(
      "Canonical record cannot be represented by the v2 contract",
      503,
      "temporarily_unavailable",
    );
  }
}

/**
 * Startup uses the exact read-path projection as a fail-closed representability
 * check without exposing a second mapping implementation.
 */
export function assertMemoryV1CodeRecordRepresentableV2(
  input: CodeRecordV2ProjectionInput,
): void {
  projectCodeRecordV2(input);
}

function toCodeRecordV2(
  record: MemoryRecordV1,
  binding: EffectiveCodeBinding,
): MemoryRecordV2 {
  assertCodeFacet({
    record,
    orgId: binding.principal.orgId,
    projectId: binding.resource.projectId,
    resourceRowId: binding.resource.resourceRowId,
  });
  return projectCodeRecordV2({
    record,
    organizationId: binding.principal.orgId,
    projectId: binding.resource.projectId,
    resourceBinding: binding.resourceBinding,
    classification: binding.resource.classification,
  });
}

function buildSearchResult(
  request: CodebaseMemorySearchV2,
  binding: EffectiveCodeBinding,
  scopeSnapshotDigest: string,
  context: MemorySearchProjectionContext,
): MemorySearchResultV2 {
  return buildMemoryV2SearchResult({
    requestId: request.request_id,
    retrievalPackId: context.retrievalPackId,
    orgId: binding.principal.orgId,
    projectId: binding.resource.projectId,
    plane: "codebase",
    resourceBinding: binding.resourceBinding,
    scopeSnapshotDigest,
    policyVersion: context.policyVersion,
    rankerVersion: context.rankerVersion,
    tokenCount: context.response.token_count,
    items: context.items,
    projectRecord: (item) => toCodeRecordV2(item.record.detail, binding),
    omittedCount: context.response.omitted_count,
    expiresAt: context.expiresAt,
    error: codeReadCoreError,
  });
}

function insertV2Pack(input: {
  request: CodebaseMemorySearchV2;
  binding: EffectiveCodeBinding;
  scopeSnapshotDigest: string;
  context: MemorySearchProjectionContext;
  result: MemorySearchResultV2;
}): void {
  persistMemoryV2SearchPack({
    request: input.request,
    principalId: input.binding.principal.servicePrincipalId,
    scope: {
      orgId: input.binding.principal.orgId,
      projectId: input.binding.resource.projectId,
      plane: "codebase",
      resourceRowId: input.binding.resource.resourceRowId,
    },
    resourceBinding: input.binding.resourceBinding,
    scopeSnapshotDigest: input.scopeSnapshotDigest,
    authorizedScopes: input.binding.authorizedScopes,
    context: input.context,
    result: input.result,
    identify: (item) => codeRecordIdentity(item.record),
  });
}

function scopeDigest(binding: EffectiveCodeBinding, request: CodebaseMemorySearchV2): string {
  return canonicalJsonSha256({
    schema_version: "pim.memory-scope-snapshot.codebase.v2",
    plane: "codebase",
    resource_binding: binding.resourceBinding,
    repository_id: binding.resource.canonicalResourceId,
    base_sha: request.applicability.base_sha,
  });
}

function toV1Search(
  request: CodebaseMemorySearchV2,
  repository: MemoryRepositoryBinding,
): MemorySearchV1 {
  return parseMemoryContract("MemorySearchV1", {
    schema_version: "pim.memory-search.v1",
    request_id: request.request_id,
    consumer: request.consumer,
    tenant: request.tenant,
    plane: "codebase",
    applicability: {
      repository_id: repository.repository_id,
      base_sha: request.applicability.base_sha,
      components: request.applicability.components,
      paths: request.applicability.paths,
      symbols: request.applicability.symbols,
      task_classes: request.applicability.task_classes,
    },
    task: request.task,
    temporal: request.temporal,
    budget: request.budget,
    options: request.options,
  });
}

function codeRecordIdentity(record: SearchableMemoryRecord) {
  return {
    recordId: record.detail.record_id,
    recordVersion: record.detail.record_version,
    contentDigest: record.version.content_digest,
  };
}

export async function searchAuthorizedCodeMemoryV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  request: CodebaseMemorySearchV2;
  dependencies?: MemorySearchDependencies;
}): Promise<MemorySearchResultV2> {
  const binding = effectiveBindingFromAuthorization(input.authorization, "search");
  const principal = binding.principal;
  const resource = binding.resource;
  if (principal.projectId !== input.request.tenant.project_id
      || (input.request.applicability.repository_id !== resource.canonicalResourceId
        && !input.authorization.canonicalAliases.includes(
          input.request.applicability.repository_id,
        ))
      || (input.request.resource_selector !== null
        && ("resource_row_id" in input.request.resource_selector
          ? input.request.resource_selector.resource_row_id !== resource.resourceRowId
          : input.request.resource_selector.canonical_resource_id !== resource.canonicalResourceId
            && !input.authorization.canonicalAliases.includes(
              input.request.resource_selector.canonical_resource_id,
            )))) {
    throw codeReadError(
      "The request does not match the authorized repository",
      403,
      "resource_binding_mismatch",
    );
  }
  if (input.request.applicability.base_sha === null) {
    throw codeReadError(
      "Codebase searches require an independently resolved base SHA",
      400,
      "schema_invalid",
      "/applicability/base_sha",
      "base_sha must be a resolved commit SHA",
    );
  }
  const normalizedRequest = parseMemoryContractV2("CodebaseMemorySearchV2", {
    ...input.request,
    resource_selector: { resource_row_id: resource.resourceRowId },
    applicability: {
      ...input.request.applicability,
      repository_id: resource.canonicalResourceId,
    },
  });
  const requestDigest = memoryV2SearchRequestDigest({
    request: normalizedRequest,
    principalId: principal.servicePrincipalId,
    resourceRowId: resource.resourceRowId,
  });
  const snapshotDigest = scopeDigest(binding, normalizedRequest);
  const v1Request = toV1Search(normalizedRequest, binding.repository);
  const readScope = {
    orgId: principal.orgId,
    projectId: normalizedRequest.tenant.project_id,
    plane: "codebase" as const,
    resourceRowId: resource.resourceRowId,
  };

  try {
    return await executeMemorySearchWithProjection({
      orgId: principal.orgId,
      principalId: principal.servicePrincipalId,
      repository: binding.repository,
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
        plane: "codebase",
        assertItems: assertStoredPackItems,
        error: codeReadCoreError,
      }),
      filterAuthorizedRecords: (records) => filterMemoryV2EligibleReadRecords({
        records,
        scope: readScope,
        now: (input.dependencies?.now?.() ?? new Date()).toISOString(),
        identify: codeRecordIdentity,
      }),
      assertAuthorizedRecords: (records: readonly SearchableMemoryRecord[]) => {
        for (const record of records) {
          assertCodeFacet({
            record: record.detail,
            orgId: principal.orgId,
            projectId: normalizedRequest.tenant.project_id,
            resourceRowId: resource.resourceRowId,
          });
        }
      },
      assertCommitRecords: (selected) => {
        const now = (input.dependencies?.now?.() ?? new Date()).toISOString();
        const current = listAuthorizedCurrentMemoryRecords({
          orgId: principal.orgId,
          projectId: normalizedRequest.tenant.project_id,
          repositoryRowId: binding.repository.repository_row_id,
          now,
        });
        for (const currentRecord of assertMemoryV2ReadVersionsStable({
          selected,
          current,
          scope: readScope,
          now,
          identify: codeRecordIdentity,
          error: codeReadCoreError,
        })) {
          assertCodeFacet({
            record: currentRecord.detail,
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
    if (error instanceof MemorySearchIdempotencyError) {
      throw codeReadError(error.message, 409, "idempotency_conflict");
    }
    throw error;
  }
}

/** In-process composition adapter used by direct callers and focused tests. */
export async function searchCodeMemoryV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  request: CodebaseMemorySearchV2;
  dependencies?: MemorySearchDependencies;
}): Promise<MemorySearchResultV2> {
  return searchAuthorizedCodeMemoryV2({
    authorization: authorizeCodeMemorySearchV2(input),
    request: input.request,
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  });
}

function recordBinding(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  record: MemoryRecordV1;
  operation: "detail" | "history";
}): EffectiveCodeBinding {
  const principal = requireProjectPrincipal(input.principal);
  const facet = facetRow(input.record.record_id, input.record.record_version);
  if (!facet || facet.org_id !== principal.orgId || facet.project_id !== principal.projectId) {
    throw codeReadError(
      "Canonical memory facet reconciliation is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  const resource = principal.resources.find((candidate) => (
    candidate.resourceRowId === facet.resource_row_id
    && candidate.resource.plane === "codebase"
    && candidate.resource.resourceType === "repository"
  ))?.resource as MemoryV2Resource | undefined;
  if (!resource) {
    throw codeReadError("Memory record is unavailable", 404, "resource_not_found");
  }
  return effectiveBindingForResource({
    principal,
    projectId: principal.projectId!,
    resource,
    operation: input.operation,
  });
}

export function getAuthorizedCodeMemoryRecordV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  recordId: string;
  recordVersion: number;
}): MemoryRecordV2 {
  const binding = effectiveBindingFromAuthorization(input.authorization, "detail");
  const principal = binding.principal;
  const record = getMemoryRecord(
    principal.orgId,
    principal.projectId!,
    input.recordId,
    input.recordVersion,
  );
  if (!record) throw codeReadError("Memory record is unavailable", 404, "resource_not_found");
  const facet = facetRow(record.record_id, record.record_version);
  if (!facet || facet.org_id !== principal.orgId || facet.project_id !== principal.projectId
      || facet.plane !== "codebase"
      || facet.resource_row_id !== binding.resource.resourceRowId) {
    throw codeReadError("Memory record is unavailable", 404, "resource_not_found");
  }
  return toCodeRecordV2(record, binding);
}

export function getAuthorizedCodeMemoryRecordHistoryV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  recordId: string;
}): MemoryRecordHistoryV2 {
  const binding = effectiveBindingFromAuthorization(input.authorization, "history");
  const principal = binding.principal;
  const history = getMemoryRecordHistory(principal.orgId, principal.projectId!, input.recordId);
  if (!history) throw codeReadError("Memory record is unavailable", 404, "resource_not_found");
  const current = getMemoryRecord(
    principal.orgId,
    principal.projectId!,
    input.recordId,
    history.current_version,
  );
  if (!current) {
    throw codeReadError(
      "Canonical memory history is incomplete",
      503,
      "temporarily_unavailable",
    );
  }
  const facet = facetRow(current.record_id, current.record_version);
  if (!facet || facet.org_id !== principal.orgId || facet.project_id !== principal.projectId
      || facet.plane !== "codebase"
      || facet.resource_row_id !== binding.resource.resourceRowId) {
    throw codeReadError("Memory record is unavailable", 404, "resource_not_found");
  }
  try {
    return parseMemoryContractV2("MemoryRecordHistoryV2", {
      schema_version: "pim.memory-record-history.v2",
      record_id: history.record_id,
      tenant: {
        organization_id: principal.orgId,
        project_id: principal.projectId,
      },
      plane: "codebase",
      resource_binding: structuredClone(binding.resourceBinding),
      current_version: history.current_version,
      lifecycle: history.lifecycle,
      versions: history.versions.map((version) => {
        const record = getMemoryRecord(
          principal.orgId,
          principal.projectId!,
          history.record_id,
          version.record_version,
        );
        if (!record) {
          throw codeReadError(
            "Canonical memory history is incomplete",
            503,
            "temporarily_unavailable",
          );
        }
        return toCodeRecordV2(record, binding);
      }),
      transitions: history.transitions.map((transition) => ({
        transition_id: transition.transition_id,
        from_status: transition.from_status,
        to_status: transition.to_status,
        reason_code: transition.reason_code,
        committed_at: transition.committed_at,
      })),
    });
  } catch (error) {
    if (error instanceof MemoryV2CodeReadError) throw error;
    throw codeReadError(
      "Canonical memory history cannot be represented by the v2 contract",
      503,
      "temporarily_unavailable",
    );
  }
}

export function getCodeMemoryRecordV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  recordId: string;
  recordVersion: number;
}): MemoryRecordV2 {
  return getAuthorizedCodeMemoryRecordV2({
    authorization: authorizeCodeMemoryRecordV2(input),
    recordId: input.recordId,
    recordVersion: input.recordVersion,
  });
}

export function authorizeCodeMemoryRecordV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  recordId: string;
  recordVersion: number;
}): AuthorizedMemoryV2ResourceContext {
  const principal = requireProjectPrincipal(input.principal);
  const record = getMemoryRecord(
    principal.orgId,
    principal.projectId!,
    input.recordId,
    input.recordVersion,
  );
  if (!record) throw codeReadError("Memory record is unavailable", 404, "resource_not_found");
  return recordBinding({ principal, record, operation: "detail" }).authorization;
}

export function getCodeMemoryRecordHistoryV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  recordId: string;
}): MemoryRecordHistoryV2 {
  return getAuthorizedCodeMemoryRecordHistoryV2({
    authorization: authorizeCodeMemoryRecordHistoryV2(input),
    recordId: input.recordId,
  });
}

export function authorizeCodeMemoryRecordHistoryV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  recordId: string;
}): AuthorizedMemoryV2ResourceContext {
  const principal = requireProjectPrincipal(input.principal);
  if (!principal.scopes.includes("memory:search")) {
    throw codeReadError("The required memory scope is unavailable", 403, "scope_required");
  }
  const history = getMemoryRecordHistory(principal.orgId, principal.projectId!, input.recordId);
  if (!history) throw codeReadError("Memory record is unavailable", 404, "resource_not_found");
  const current = getMemoryRecord(
    principal.orgId,
    principal.projectId!,
    input.recordId,
    history.current_version,
  );
  if (!current) {
    throw codeReadError("Canonical memory history is incomplete", 503, "temporarily_unavailable");
  }
  return recordBinding({ principal, record: current, operation: "history" }).authorization;
}

function assertStoredPackItems(
  row: MemoryV2StoredPackRow,
  items: readonly MemoryV2StoredPackItemRow[],
): void {
  for (const item of items) {
    const record = getMemoryRecord(
      row.org_id,
      row.project_id,
      item.record_id,
      item.record_version,
    );
    if (!record) {
      throw codeReadError(
        "Stored v2 retrieval pack item is unavailable",
        503,
        "temporarily_unavailable",
      );
    }
    assertCodeFacet({
      record,
      orgId: row.org_id,
      projectId: row.project_id,
      resourceRowId: row.resource_row_id,
    });
  }
}

export function getAuthorizedCodeMemoryPackV2(input: {
  authorization: AuthorizedMemoryV2ResourceContext;
  packId: string;
  now?: string;
}): MemoryRetrievalPackV2 {
  const binding = effectiveBindingFromAuthorization(input.authorization, "pack");
  return readAuthorizedMemoryV2Pack({
    packId: input.packId,
    orgId: binding.principal.orgId,
    projectId: binding.resource.projectId,
    plane: "codebase",
    resourceRowId: binding.resource.resourceRowId,
    now: input.now ?? new Date().toISOString(),
    assertItems: assertStoredPackItems,
    error: codeReadCoreError,
  });
}

export function getCodeMemoryPackV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  packId: string;
  now?: string;
}): MemoryRetrievalPackV2 {
  return getAuthorizedCodeMemoryPackV2({
    authorization: authorizeCodeMemoryPackV2(input),
    packId: input.packId,
    ...(input.now ? { now: input.now } : {}),
  });
}

export function authorizeCodeMemoryPackV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  packId: string;
}): AuthorizedMemoryV2ResourceContext {
  const principal = requireProjectPrincipal(input.principal);
  const row = db.prepare(
    `SELECT resource_row_id FROM memory_v2_retrieval_packs
     WHERE retrieval_pack_id = ? AND org_id = ? AND project_id = ? AND plane = 'codebase'`,
  ).get(input.packId, principal.orgId, principal.projectId!) as {
    resource_row_id: string;
  } | undefined;
  if (!row) throw codeReadError("Memory retrieval pack is unavailable", 404, "resource_not_found");
  const resource = principal.resources.find((candidate) => (
    candidate.resourceRowId === row.resource_row_id
    && candidate.resource.plane === "codebase"
    && candidate.resource.resourceType === "repository"
  ))?.resource as MemoryV2Resource | undefined;
  if (!resource) throw codeReadError("Memory retrieval pack is unavailable", 404, "resource_not_found");
  return effectiveBindingForResource({
    principal,
    projectId: principal.projectId!,
    resource,
    operation: "pack",
  }).authorization;
}
