import { randomUUID } from "node:crypto";
import db, { withImmediateTransaction } from "../db/connection.js";
import {
  MEMORY_V2_OPERATIONS,
  memoryV2OperationsForScopes,
  type ImplementedMemoryV2Plane,
  type ImplementedMemoryV2ResourceType,
  type MemoryV2Operation,
} from "./memory-v2-constants.js";

export interface MemoryV2Resource {
  resourceRowId: string;
  orgId: string;
  projectId: string;
  plane: ImplementedMemoryV2Plane;
  resourceType: ImplementedMemoryV2ResourceType;
  canonicalResourceId: string;
  displayLabel: string;
  provider: string | null;
  providerResourceId: string | null;
  classification: "public" | "internal" | "confidential" | "restricted";
  retentionReference: string | null;
  validFrom: string;
  validUntil: string | null;
}

export interface MemoryV2ResourceBinding {
  bindingId: string;
  tokenId: string;
  servicePrincipalId: string;
  orgId: string;
  projectId: string;
  resourceRowId: string;
  operations: MemoryV2Operation[];
  resource: MemoryV2Resource;
}

interface ResourceRow {
  resource_row_id: string;
  org_id: string;
  project_id: string;
  plane: ImplementedMemoryV2Plane;
  resource_type: ImplementedMemoryV2ResourceType;
  canonical_resource_id: string;
  display_label: string;
  provider: string | null;
  provider_resource_id: string | null;
  classification: MemoryV2Resource["classification"];
  retention_reference: string | null;
  valid_from: string;
  valid_until: string | null;
}

interface BindingRow extends ResourceRow {
  binding_id: string;
  token_id: string;
  service_principal_id: string;
  operations_json: string;
}

interface RepositoryProjectionRow {
  repository_row_id: string;
  org_id: string;
  project_id: string;
  provider: string;
  provider_repository_id: string;
  repository_id: string;
  display_slug: string;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
}

interface HarnessProjectionRow {
  org_id: string;
  project_id: string;
  harness_id: string;
  created_at: string;
}

interface RepositoryAliasProjectionRow {
  alias_id: string;
  repository_row_id: string;
  org_id: string;
  project_id: string;
  alias_repository_id: string;
  reason: "rename" | "transfer" | "import";
  valid_from: string;
  valid_until: string | null;
  created_at: string;
}

export class MemoryV2ResourceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: "resource_binding_mismatch" | "idempotency_conflict",
  ) {
    super(message);
    this.name = "MemoryV2ResourceError";
  }
}

function resourceFromRow(row: ResourceRow): MemoryV2Resource {
  return {
    resourceRowId: row.resource_row_id,
    orgId: row.org_id,
    projectId: row.project_id,
    plane: row.plane,
    resourceType: row.resource_type,
    canonicalResourceId: row.canonical_resource_id,
    displayLabel: row.display_label,
    provider: row.provider,
    providerResourceId: row.provider_resource_id,
    classification: row.classification,
    retentionReference: row.retention_reference,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
  };
}

function parseOperations(raw: string): MemoryV2Operation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const allowed = new Set<string>(MEMORY_V2_OPERATIONS);
  return parsed.filter((item): item is MemoryV2Operation => (
    typeof item === "string" && allowed.has(item)
  ));
}

function harnessIdentityPart(value: string): string {
  return Buffer.from(value, "utf8").toString("hex").toUpperCase();
}

export function memoryV2RepositoryResourceRowId(repositoryRowId: string): string {
  return `v2res_repository:${repositoryRowId}`;
}

export function memoryV2HarnessSourceRowId(input: {
  orgId: string;
  projectId: string;
  harnessId: string;
}): string {
  return `identity:${harnessIdentityPart(input.orgId)}:${harnessIdentityPart(input.projectId)}:${harnessIdentityPart(input.harnessId)}`;
}

export function resolveMemoryV2HarnessResourceRowId(input: {
  orgId: string;
  projectId: string;
  harnessId: string;
}): string | null {
  const row = db.prepare(
    `SELECT resource_row_id FROM memory_v2_resources
     WHERE source_authority = 'memory_harness_principal_bindings'
       AND source_row_id = ?`,
  ).get(memoryV2HarnessSourceRowId(input)) as { resource_row_id: string } | undefined;
  return row?.resource_row_id ?? null;
}

export function getMemoryV2Resource(resourceRowId: string): MemoryV2Resource | null {
  const row = db.prepare(
    `SELECT resource_row_id, org_id, project_id, plane, resource_type,
            canonical_resource_id, display_label, provider, provider_resource_id,
            classification, retention_reference, valid_from, valid_until
     FROM memory_v2_resources WHERE resource_row_id = ?`,
  ).get(resourceRowId) as ResourceRow | undefined;
  return row ? resourceFromRow(row) : null;
}

export function resolveMemoryV2Resource(input: {
  orgId: string;
  projectId: string;
  plane: ImplementedMemoryV2Plane;
  canonicalResourceId: string;
}): MemoryV2Resource | null {
  const row = db.prepare(
    `SELECT resource_row_id, org_id, project_id, plane, resource_type,
            canonical_resource_id, display_label, provider, provider_resource_id,
            classification, retention_reference, valid_from, valid_until
     FROM memory_v2_resources
     WHERE org_id = ? AND project_id = ? AND plane = ?
       AND canonical_resource_id = ? AND valid_until IS NULL`,
  ).get(
    input.orgId,
    input.projectId,
    input.plane,
    input.canonicalResourceId,
  ) as ResourceRow | undefined;
  if (row) return resourceFromRow(row);

  const alias = db.prepare(
    `SELECT resource.resource_row_id, resource.org_id, resource.project_id,
            resource.plane, resource.resource_type, resource.canonical_resource_id,
            resource.display_label, resource.provider, resource.provider_resource_id,
            resource.classification, resource.retention_reference,
            resource.valid_from, resource.valid_until
     FROM memory_v2_resource_aliases AS alias
     INNER JOIN memory_v2_resources AS resource
       ON resource.resource_row_id = alias.resource_row_id
      AND resource.org_id = alias.org_id
      AND resource.project_id = alias.project_id
      AND resource.plane = alias.plane
     WHERE alias.org_id = ? AND alias.project_id = ? AND alias.plane = ?
       AND alias.alias_canonical_resource_id = ? AND alias.valid_until IS NULL
       AND resource.valid_until IS NULL`,
  ).get(
    input.orgId,
    input.projectId,
    input.plane,
    input.canonicalResourceId,
  ) as ResourceRow | undefined;
  return alias ? resourceFromRow(alias) : null;
}

function projectMemoryV2RepositoryResourceInTransaction(
  repositoryRowId: string,
): MemoryV2Resource {
  const source = db.prepare(
    "SELECT * FROM memory_repository_registry WHERE repository_row_id = ?",
  ).get(repositoryRowId) as unknown as RepositoryProjectionRow | undefined;
  if (!source) {
    throw new MemoryV2ResourceError(
      "Repository authority row is unavailable",
      403,
      "resource_binding_mismatch",
    );
  }
  const resourceRowId = memoryV2RepositoryResourceRowId(source.repository_row_id);
  const existing = getMemoryV2Resource(resourceRowId);
  if (existing) {
    if (
      existing.orgId !== source.org_id
      || existing.projectId !== source.project_id
      || existing.plane !== "codebase"
      || existing.resourceType !== "repository"
      || existing.canonicalResourceId !== source.repository_id
      || existing.displayLabel !== source.display_slug
      || existing.provider !== source.provider
      || existing.providerResourceId !== source.provider_repository_id
      || existing.validFrom !== source.valid_from
      || existing.validUntil !== source.valid_until
    ) {
      throw new MemoryV2ResourceError(
        "Repository resource companion is missing or conflicts with its authority row",
        409,
        "idempotency_conflict",
      );
    }
    return existing;
  }
  db.prepare(
    `INSERT INTO memory_v2_resources
       (resource_row_id, org_id, project_id, plane, resource_type,
        canonical_resource_id, display_label, provider, provider_resource_id,
        classification, retention_reference, source_authority, source_row_id,
        valid_from, valid_until, created_at, updated_at)
     VALUES (?, ?, ?, 'codebase', 'repository', ?, ?, ?, ?, 'internal', NULL,
             'memory_repository_registry', ?, ?, ?, ?, ?)`,
  ).run(
    resourceRowId,
    source.org_id,
    source.project_id,
    source.repository_id,
    source.display_slug,
    source.provider,
    source.provider_repository_id,
    source.repository_row_id,
    source.valid_from,
    source.valid_until,
    source.created_at,
    source.updated_at,
  );
  return getMemoryV2Resource(resourceRowId)!;
}

export function projectMemoryV2RepositoryResource(
  repositoryRowId: string,
): MemoryV2Resource {
  return withImmediateTransaction(() => (
    projectMemoryV2RepositoryResourceInTransaction(repositoryRowId)
  ));
}

/** Updates only the mutable projection fields after an authority-row rename/transfer. */
export function synchronizeMemoryV2RepositoryResource(
  repositoryRowId: string,
): MemoryV2Resource {
  return withImmediateTransaction(() => {
    const source = db.prepare(
    "SELECT * FROM memory_repository_registry WHERE repository_row_id = ?",
    ).get(repositoryRowId) as unknown as RepositoryProjectionRow | undefined;
    const resourceRowId = memoryV2RepositoryResourceRowId(repositoryRowId);
    const existing = getMemoryV2Resource(resourceRowId);
    if (!source || !existing
        || existing.orgId !== source.org_id
        || existing.plane !== "codebase"
        || existing.resourceType !== "repository"
        || existing.provider !== source.provider
        || existing.providerResourceId !== source.provider_repository_id) {
      throw new MemoryV2ResourceError(
        "Repository resource identity conflicts with its authority row",
        409,
        "idempotency_conflict",
      );
    }
    db.prepare(
      `UPDATE memory_v2_resources
       SET project_id = ?, canonical_resource_id = ?, display_label = ?,
           valid_from = ?, valid_until = ?, updated_at = ?
       WHERE resource_row_id = ?`,
    ).run(
      source.project_id,
      source.repository_id,
      source.display_slug,
      source.valid_from,
      source.valid_until,
      source.updated_at,
      resourceRowId,
    );
    return projectMemoryV2RepositoryResourceInTransaction(repositoryRowId);
  });
}

export function projectMemoryV2RepositoryAlias(aliasId: string): void {
  const source = db.prepare(
    "SELECT * FROM memory_repository_aliases WHERE alias_id = ?",
  ).get(aliasId) as unknown as RepositoryAliasProjectionRow | undefined;
  if (!source) {
    throw new MemoryV2ResourceError(
      "Repository alias authority row is unavailable",
      403,
      "resource_binding_mismatch",
    );
  }
  const resource = getMemoryV2Resource(memoryV2RepositoryResourceRowId(source.repository_row_id));
  if (!resource || resource.orgId !== source.org_id) {
    throw new MemoryV2ResourceError(
      "Repository alias does not match its companion resource",
      409,
      "idempotency_conflict",
    );
  }
  const aliasRowId = `v2alias_repository:${source.alias_id}`;
  const existing = db.prepare(
    `SELECT resource_row_id, org_id, project_id, plane, resource_type,
            alias_canonical_resource_id, reason, source_alias_row_id,
            valid_from, valid_until, created_at
     FROM memory_v2_resource_aliases WHERE alias_row_id = ?`,
  ).get(aliasRowId) as {
    resource_row_id: string;
    org_id: string;
    project_id: string;
    plane: string;
    resource_type: string;
    alias_canonical_resource_id: string;
    reason: string;
    source_alias_row_id: string;
    valid_from: string;
    valid_until: string | null;
    created_at: string;
  } | undefined;
  if (existing) {
    if (existing.resource_row_id !== resource.resourceRowId
        || existing.org_id !== source.org_id
        || existing.project_id !== source.project_id
        || existing.plane !== "codebase"
        || existing.resource_type !== "repository"
        || existing.alias_canonical_resource_id !== source.alias_repository_id
        || existing.reason !== source.reason
        || existing.source_alias_row_id !== source.alias_id
        || existing.valid_from !== source.valid_from
        || existing.valid_until !== source.valid_until
        || existing.created_at !== source.created_at) {
      throw new MemoryV2ResourceError(
        "Repository alias companion conflicts with its authority row",
        409,
        "idempotency_conflict",
      );
    }
    return;
  }
  db.prepare(
    `INSERT INTO memory_v2_resource_aliases
       (alias_row_id, resource_row_id, org_id, project_id, plane, resource_type,
        alias_canonical_resource_id, reason, source_alias_row_id,
        valid_from, valid_until, created_at)
     VALUES (?, ?, ?, ?, 'codebase', 'repository', ?, ?, ?, ?, ?, ?)`,
  ).run(
    aliasRowId,
    resource.resourceRowId,
    source.org_id,
    source.project_id,
    source.alias_repository_id,
    source.reason,
    source.alias_id,
    source.valid_from,
    source.valid_until,
    source.created_at,
  );
}

function projectMemoryV2HarnessResourceInTransaction(input: {
  orgId: string;
  projectId: string;
  harnessId: string;
}): MemoryV2Resource {
  const source = db.prepare(
    `SELECT org_id, project_id, harness_id, MIN(created_at) AS created_at
     FROM memory_harness_principal_bindings
     WHERE org_id = ? AND project_id = ? AND harness_id = ?
     GROUP BY org_id, project_id, harness_id`,
  ).get(input.orgId, input.projectId, input.harnessId) as HarnessProjectionRow | undefined;
  if (!source) {
    throw new MemoryV2ResourceError(
      "Harness authority row is unavailable",
      403,
      "resource_binding_mismatch",
    );
  }
  const existingResourceRowId = resolveMemoryV2HarnessResourceRowId(input);
  const existing = existingResourceRowId ? getMemoryV2Resource(existingResourceRowId) : null;
  if (existing) {
    if (existing.orgId !== source.org_id
        || existing.projectId !== source.project_id
        || existing.plane !== "harness"
        || existing.resourceType !== "harness"
        || existing.canonicalResourceId !== source.harness_id
        || existing.displayLabel !== source.harness_id
        || existing.provider !== null
        || existing.providerResourceId !== null
        || existing.validFrom !== source.created_at
        || existing.validUntil !== null) {
      throw new MemoryV2ResourceError(
        "Harness resource companion conflicts with its authority row",
        409,
        "idempotency_conflict",
      );
    }
    return existing;
  }
  const resourceRowId = `v2res_harness:${randomUUID()}`;
  const sourceRowId = memoryV2HarnessSourceRowId(input);
  db.prepare(
    `INSERT INTO memory_v2_resources
       (resource_row_id, org_id, project_id, plane, resource_type,
        canonical_resource_id, display_label, provider, provider_resource_id,
        classification, retention_reference, source_authority, source_row_id,
        valid_from, valid_until, created_at, updated_at)
     VALUES (?, ?, ?, 'harness', 'harness', ?, ?, NULL, NULL, 'internal', NULL,
             'memory_harness_principal_bindings', ?, ?, NULL, ?, ?)`,
  ).run(
    resourceRowId,
    source.org_id,
    source.project_id,
    source.harness_id,
    source.harness_id,
    sourceRowId,
    source.created_at,
    source.created_at,
    source.created_at,
  );
  return getMemoryV2Resource(resourceRowId)!;
}

export function projectMemoryV2HarnessResource(input: {
  orgId: string;
  projectId: string;
  harnessId: string;
}): MemoryV2Resource {
  return withImmediateTransaction(() => projectMemoryV2HarnessResourceInTransaction(input));
}

function bindingFromRow(row: BindingRow): MemoryV2ResourceBinding {
  return {
    bindingId: row.binding_id,
    tokenId: row.token_id,
    servicePrincipalId: row.service_principal_id,
    orgId: row.org_id,
    projectId: row.project_id,
    resourceRowId: row.resource_row_id,
    operations: parseOperations(row.operations_json),
    resource: resourceFromRow(row),
  };
}

export function getMemoryV2ResourceBinding(input: {
  tokenId: string;
  servicePrincipalId: string;
  orgId: string;
  projectId: string;
  plane: ImplementedMemoryV2Plane;
  resourceRowId: string;
}): MemoryV2ResourceBinding | null {
  const row = db.prepare(
    `SELECT binding.binding_id, binding.token_id, binding.service_principal_id,
            binding.operations_json, resource.resource_row_id, resource.org_id,
            resource.project_id, resource.plane, resource.resource_type,
            resource.canonical_resource_id, resource.display_label, resource.provider,
            resource.provider_resource_id, resource.classification,
            resource.retention_reference, resource.valid_from, resource.valid_until
     FROM memory_v2_service_token_resource_bindings AS binding
     INNER JOIN memory_v2_resources AS resource
       ON resource.resource_row_id = binding.resource_row_id
     WHERE binding.token_id = ? AND binding.service_principal_id = ?
       AND binding.org_id = ? AND binding.project_id = ?
       AND resource.org_id = binding.org_id AND resource.project_id = binding.project_id
       AND resource.plane = ? AND resource.resource_row_id = ?
       AND (
         (binding.source_binding_type = 'repository_token_binding' AND EXISTS (
           SELECT 1 FROM memory_service_token_repository_bindings AS legacy
           WHERE legacy.binding_id = binding.source_binding_id
             AND legacy.token_id = binding.token_id
             AND legacy.service_principal_id = binding.service_principal_id
             AND legacy.org_id = binding.org_id
             AND legacy.project_id = binding.project_id
             AND legacy.repository_row_id = resource.source_row_id
             AND resource.source_authority = 'memory_repository_registry'
             AND resource.plane = 'codebase'
             AND resource.resource_type = 'repository'
         ))
         OR
         (binding.source_binding_type = 'harness_principal_binding' AND EXISTS (
           SELECT 1 FROM memory_harness_principal_bindings AS legacy
           WHERE legacy.binding_id = binding.source_binding_id
             AND legacy.service_principal_id = binding.service_principal_id
             AND legacy.org_id = binding.org_id
             AND legacy.project_id = binding.project_id
             AND legacy.harness_id = resource.canonical_resource_id
             AND resource.source_authority = 'memory_harness_principal_bindings'
             AND resource.plane = 'harness'
             AND resource.resource_type = 'harness'
         ))
       )
       AND resource.valid_until IS NULL`,
  ).get(
    input.tokenId,
    input.servicePrincipalId,
    input.orgId,
    input.projectId,
    input.plane,
    input.resourceRowId,
  ) as BindingRow | undefined;
  return row ? bindingFromRow(row) : null;
}

export function listMemoryV2ResourceBindings(input: {
  tokenId: string;
  servicePrincipalId: string;
  orgId: string;
  projectId: string;
}): MemoryV2ResourceBinding[] {
  const rows = db.prepare(
    `SELECT binding.binding_id, binding.token_id, binding.service_principal_id,
            binding.operations_json, resource.resource_row_id, resource.org_id,
            resource.project_id, resource.plane, resource.resource_type,
            resource.canonical_resource_id, resource.display_label, resource.provider,
            resource.provider_resource_id, resource.classification,
            resource.retention_reference, resource.valid_from, resource.valid_until
     FROM memory_v2_service_token_resource_bindings AS binding
     INNER JOIN memory_v2_resources AS resource
       ON resource.resource_row_id = binding.resource_row_id
     WHERE binding.token_id = ? AND binding.service_principal_id = ?
       AND binding.org_id = ? AND binding.project_id = ?
       AND resource.org_id = binding.org_id AND resource.project_id = binding.project_id
       AND (
         (binding.source_binding_type = 'repository_token_binding' AND EXISTS (
           SELECT 1 FROM memory_service_token_repository_bindings AS legacy
           WHERE legacy.binding_id = binding.source_binding_id
             AND legacy.token_id = binding.token_id
             AND legacy.service_principal_id = binding.service_principal_id
             AND legacy.org_id = binding.org_id
             AND legacy.project_id = binding.project_id
             AND legacy.repository_row_id = resource.source_row_id
             AND resource.source_authority = 'memory_repository_registry'
             AND resource.plane = 'codebase'
             AND resource.resource_type = 'repository'
         ))
         OR
         (binding.source_binding_type = 'harness_principal_binding' AND EXISTS (
           SELECT 1 FROM memory_harness_principal_bindings AS legacy
           WHERE legacy.binding_id = binding.source_binding_id
             AND legacy.service_principal_id = binding.service_principal_id
             AND legacy.org_id = binding.org_id
             AND legacy.project_id = binding.project_id
             AND legacy.harness_id = resource.canonical_resource_id
             AND resource.source_authority = 'memory_harness_principal_bindings'
             AND resource.plane = 'harness'
             AND resource.resource_type = 'harness'
         ))
       )
       AND resource.valid_until IS NULL
     ORDER BY resource.plane, resource.canonical_resource_id`,
  ).all(
    input.tokenId,
    input.servicePrincipalId,
    input.orgId,
    input.projectId,
  ) as unknown as BindingRow[];
  return rows.map(bindingFromRow);
}

function parsedScopes(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function insertProjectedBinding(input: {
  bindingId: string;
  tokenId: string;
  servicePrincipalId: string;
  orgId: string;
  projectId: string;
  resourceRowId: string;
  operations: MemoryV2Operation[];
  sourceBindingType: "repository_token_binding" | "harness_principal_binding";
  sourceBindingId: string;
  createdAt: string;
}): boolean {
  if (input.operations.length === 0) return false;
  const existing = db.prepare(
    `SELECT binding_id, service_principal_id, org_id, project_id, operations_json,
            source_binding_type, source_binding_id
     FROM memory_v2_service_token_resource_bindings
     WHERE token_id = ? AND resource_row_id = ?`,
  ).get(input.tokenId, input.resourceRowId) as {
    binding_id: string;
    service_principal_id: string;
    org_id: string;
    project_id: string;
    operations_json: string;
    source_binding_type: string;
    source_binding_id: string;
  } | undefined;
  if (existing) {
    if (existing.binding_id !== input.bindingId
        || existing.service_principal_id !== input.servicePrincipalId
        || existing.org_id !== input.orgId
        || existing.project_id !== input.projectId
        || existing.source_binding_type !== input.sourceBindingType
        || existing.source_binding_id !== input.sourceBindingId
        || JSON.stringify(parseOperations(existing.operations_json)) !== JSON.stringify(input.operations)) {
      throw new MemoryV2ResourceError(
        "Immutable v2 token binding no longer matches its exact scopes",
        409,
        "idempotency_conflict",
      );
    }
    return false;
  }
  db.prepare(
    `INSERT INTO memory_v2_service_token_resource_bindings
       (binding_id, token_id, service_principal_id, org_id, project_id,
        resource_row_id, operations_json, source_binding_type, source_binding_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.bindingId,
    input.tokenId,
    input.servicePrincipalId,
    input.orgId,
    input.projectId,
    input.resourceRowId,
    JSON.stringify(input.operations),
    input.sourceBindingType,
    input.sourceBindingId,
    input.createdAt,
  );
  return true;
}

/**
 * Transaction-aware hook for service-token creation. The caller must invoke
 * this after its legacy exact-resource bindings and before committing.
 */
export function projectMemoryV2BindingsForToken(tokenId: string): number {
  let inserted = 0;
  const repositories = db.prepare(
    `SELECT legacy.binding_id, legacy.token_id, legacy.service_principal_id,
            legacy.org_id, legacy.project_id, legacy.repository_row_id,
            legacy.created_at, token.scopes_json
     FROM memory_service_token_repository_bindings AS legacy
     INNER JOIN service_tokens AS token ON token.token_id = legacy.token_id
     WHERE legacy.token_id = ?`,
  ).all(tokenId) as unknown as Array<{
    binding_id: string;
    token_id: string;
    service_principal_id: string;
    org_id: string;
    project_id: string;
    repository_row_id: string;
    created_at: string;
    scopes_json: string;
  }>;
  for (const row of repositories) {
    const operations = memoryV2OperationsForScopes("codebase", parsedScopes(row.scopes_json));
    if (operations.length === 0) continue;
    const resource = projectMemoryV2RepositoryResource(row.repository_row_id);
    if (insertProjectedBinding({
      bindingId: `v2bind_repository:${row.binding_id}`,
      tokenId: row.token_id,
      servicePrincipalId: row.service_principal_id,
      orgId: row.org_id,
      projectId: row.project_id,
      resourceRowId: resource.resourceRowId,
      operations,
      sourceBindingType: "repository_token_binding",
      sourceBindingId: row.binding_id,
      createdAt: row.created_at,
    })) inserted += 1;
  }
  const harnesses = db.prepare(
    `SELECT legacy.binding_id, legacy.service_principal_id, legacy.org_id,
            legacy.project_id, legacy.harness_id, legacy.created_at,
            token.token_id, token.scopes_json
     FROM memory_harness_principal_bindings AS legacy
     INNER JOIN service_tokens AS token
       ON token.service_principal_id = legacy.service_principal_id
      AND token.project_id = legacy.project_id
     WHERE token.token_id = ?`,
  ).all(tokenId) as unknown as Array<{
    binding_id: string;
    service_principal_id: string;
    org_id: string;
    project_id: string;
    harness_id: string;
    created_at: string;
    token_id: string;
    scopes_json: string;
  }>;
  for (const row of harnesses) {
    const operations = memoryV2OperationsForScopes("harness", parsedScopes(row.scopes_json));
    if (operations.length === 0) continue;
    const resource = projectMemoryV2HarnessResource({
      orgId: row.org_id,
      projectId: row.project_id,
      harnessId: row.harness_id,
    });
    if (insertProjectedBinding({
      bindingId: `v2bind_harness:${row.token_id}:${row.binding_id}`,
      tokenId: row.token_id,
      servicePrincipalId: row.service_principal_id,
      orgId: row.org_id,
      projectId: row.project_id,
      resourceRowId: resource.resourceRowId,
      operations,
      sourceBindingType: "harness_principal_binding",
      sourceBindingId: row.binding_id,
      createdAt: row.created_at,
    })) inserted += 1;
  }
  return inserted;
}

/** Projects all already-issued tokens affected by one new harness binding. */
export function projectMemoryV2HarnessPrincipalBinding(bindingId: string): number {
  const tokenRows = db.prepare(
    `SELECT token.token_id
     FROM memory_harness_principal_bindings AS binding
     INNER JOIN service_tokens AS token
       ON token.service_principal_id = binding.service_principal_id
      AND token.project_id = binding.project_id
     WHERE binding.binding_id = ?`,
  ).all(bindingId) as unknown as Array<{ token_id: string }>;
  let inserted = 0;
  for (const row of tokenRows) inserted += projectMemoryV2BindingsForToken(row.token_id);
  return inserted;
}

export function projectMemoryV2ResourceBindings(): number {
  return withImmediateTransaction(() => {
    let inserted = 0;
    const repositories = db.prepare(
      `SELECT legacy.binding_id, legacy.token_id, legacy.service_principal_id,
              legacy.org_id, legacy.project_id, legacy.repository_row_id,
              legacy.created_at, token.scopes_json
       FROM memory_service_token_repository_bindings AS legacy
       INNER JOIN service_tokens AS token ON token.token_id = legacy.token_id`,
    ).all() as unknown as Array<{
      binding_id: string;
      token_id: string;
      service_principal_id: string;
      org_id: string;
      project_id: string;
      repository_row_id: string;
      created_at: string;
      scopes_json: string;
    }>;
    for (const row of repositories) {
      const operations = memoryV2OperationsForScopes("codebase", parsedScopes(row.scopes_json));
      if (operations.length === 0) continue;
      const resource = projectMemoryV2RepositoryResource(row.repository_row_id);
      if (insertProjectedBinding({
        bindingId: `v2bind_repository:${row.binding_id}`,
        tokenId: row.token_id,
        servicePrincipalId: row.service_principal_id,
        orgId: row.org_id,
        projectId: row.project_id,
        resourceRowId: resource.resourceRowId,
        operations,
        sourceBindingType: "repository_token_binding",
        sourceBindingId: row.binding_id,
        createdAt: row.created_at,
      })) inserted += 1;
    }

    const harnesses = db.prepare(
      `SELECT legacy.binding_id, legacy.service_principal_id, legacy.org_id,
              legacy.project_id, legacy.harness_id, legacy.created_at,
              token.token_id, token.scopes_json
       FROM memory_harness_principal_bindings AS legacy
       INNER JOIN service_tokens AS token
         ON token.service_principal_id = legacy.service_principal_id
        AND token.project_id = legacy.project_id`,
    ).all() as unknown as Array<{
      binding_id: string;
      service_principal_id: string;
      org_id: string;
      project_id: string;
      harness_id: string;
      created_at: string;
      token_id: string;
      scopes_json: string;
    }>;
    for (const row of harnesses) {
      const operations = memoryV2OperationsForScopes("harness", parsedScopes(row.scopes_json));
      if (operations.length === 0) continue;
      const resource = projectMemoryV2HarnessResource({
        orgId: row.org_id,
        projectId: row.project_id,
        harnessId: row.harness_id,
      });
      if (insertProjectedBinding({
        bindingId: `v2bind_harness:${row.token_id}:${row.binding_id}`,
        tokenId: row.token_id,
        servicePrincipalId: row.service_principal_id,
        orgId: row.org_id,
        projectId: row.project_id,
        resourceRowId: resource.resourceRowId,
        operations,
        sourceBindingType: "harness_principal_binding",
        sourceBindingId: row.binding_id,
        createdAt: row.created_at,
      })) inserted += 1;
    }
    return inserted;
  });
}

export function projectMemoryV2Resources(): {
  repositories: number;
  harnesses: number;
  bindings: number;
} {
  return withImmediateTransaction(() => {
    let repositories = 0;
    const repositoryRows = db.prepare(
      "SELECT repository_row_id FROM memory_repository_registry ORDER BY repository_row_id",
    ).all() as unknown as Array<{ repository_row_id: string }>;
    for (const row of repositoryRows) {
      if (!getMemoryV2Resource(memoryV2RepositoryResourceRowId(row.repository_row_id))) repositories += 1;
      projectMemoryV2RepositoryResource(row.repository_row_id);
    }
    let harnesses = 0;
    const harnessRows = db.prepare(
      `SELECT org_id, project_id, harness_id
       FROM memory_harness_principal_bindings
       GROUP BY org_id, project_id, harness_id
       ORDER BY org_id, project_id, harness_id`,
    ).all() as unknown as Array<{ org_id: string; project_id: string; harness_id: string }>;
    for (const row of harnessRows) {
      if (!resolveMemoryV2HarnessResourceRowId({
        orgId: row.org_id,
        projectId: row.project_id,
        harnessId: row.harness_id,
      })) harnesses += 1;
      projectMemoryV2HarnessResource({
        orgId: row.org_id,
        projectId: row.project_id,
        harnessId: row.harness_id,
      });
    }
    const bindings = projectMemoryV2ResourceBindings();
    return { repositories, harnesses, bindings };
  });
}

export interface MemoryV2ResourceReconciliation {
  repositoryAuthorityCount: number;
  repositoryProjectionCount: number;
  repositoryIdentityMismatchCount: number;
  harnessAuthorityCount: number;
  harnessProjectionCount: number;
  harnessIdentityMismatchCount: number;
  aliasAuthorityCount: number;
  aliasProjectionCount: number;
  aliasIdentityMismatchCount: number;
  expectedBindingCount: number;
  bindingProjectionCount: number;
  bindingIdentityMismatchCount: number;
  foreignKeyViolationCount: number;
  ok: boolean;
}

function symmetricProjectionMismatchCount(
  expected: readonly string[],
  projected: readonly string[],
): number {
  const expectedSet = new Set(expected);
  const projectedSet = new Set(projected);
  let mismatches = 0;
  for (const value of expectedSet) if (!projectedSet.has(value)) mismatches += 1;
  for (const value of projectedSet) if (!expectedSet.has(value)) mismatches += 1;
  return mismatches;
}

export function reconcileMemoryV2Resources(): MemoryV2ResourceReconciliation {
  const count = (sql: string): number => (
    db.prepare(sql).get() as { count: number }
  ).count;
  const repositoryAuthorityCount = count("SELECT COUNT(*) AS count FROM memory_repository_registry");
  const repositoryProjectionCount = count(
    "SELECT COUNT(*) AS count FROM memory_v2_resources WHERE plane = 'codebase'",
  );
  const repositoryIdentityMismatchCount = count(
    `SELECT COUNT(*) AS count
     FROM memory_repository_registry AS legacy
     LEFT JOIN memory_v2_resources AS resource
       ON resource.source_authority = 'memory_repository_registry'
      AND resource.source_row_id = legacy.repository_row_id
     WHERE resource.resource_row_id IS NULL
        OR resource.org_id <> legacy.org_id
        OR resource.project_id <> legacy.project_id
        OR resource.canonical_resource_id <> legacy.repository_id
        OR resource.provider_resource_id <> legacy.provider_repository_id`,
  );
  const harnessAuthorityCount = count(
    `SELECT COUNT(*) AS count FROM (
       SELECT org_id, project_id, harness_id
       FROM memory_harness_principal_bindings
       GROUP BY org_id, project_id, harness_id
     )`,
  );
  const harnessProjectionCount = count(
    "SELECT COUNT(*) AS count FROM memory_v2_resources WHERE plane = 'harness'",
  );
  const harnessIdentityMismatchCount = count(
    `SELECT COUNT(*) AS count FROM (
       SELECT legacy.org_id, legacy.project_id, legacy.harness_id
       FROM memory_harness_principal_bindings AS legacy
       LEFT JOIN memory_v2_resources AS resource
         ON resource.org_id = legacy.org_id
        AND resource.project_id = legacy.project_id
        AND resource.plane = 'harness'
        AND resource.canonical_resource_id = legacy.harness_id
       WHERE resource.resource_row_id IS NULL
       GROUP BY legacy.org_id, legacy.project_id, legacy.harness_id
     )`,
  );
  const expectedAliases = (db.prepare(
    `SELECT 'v2alias_repository:' || alias.alias_id AS alias_row_id,
            resource.resource_row_id, alias.org_id, alias.project_id,
            alias.alias_repository_id, alias.reason, alias.alias_id AS source_alias_row_id,
            alias.valid_from, alias.valid_until, alias.created_at
     FROM memory_repository_aliases AS alias
     INNER JOIN memory_v2_resources AS resource
       ON resource.source_authority = 'memory_repository_registry'
      AND resource.source_row_id = alias.repository_row_id
     ORDER BY alias.alias_id`,
  ).all() as unknown as Array<Record<string, unknown>>).map((row) => JSON.stringify(row));
  const projectedAliases = (db.prepare(
    `SELECT alias_row_id, resource_row_id, org_id, project_id,
            alias_canonical_resource_id AS alias_repository_id, reason,
            source_alias_row_id, valid_from, valid_until, created_at
     FROM memory_v2_resource_aliases ORDER BY source_alias_row_id`,
  ).all() as unknown as Array<Record<string, unknown>>).map((row) => JSON.stringify(row));
  const aliasAuthorityCount = expectedAliases.length;
  const aliasProjectionCount = projectedAliases.length;
  const aliasIdentityMismatchCount = symmetricProjectionMismatchCount(
    expectedAliases,
    projectedAliases,
  );

  type ExpectedBindingRow = {
    binding_id: string;
    token_id: string;
    service_principal_id: string;
    org_id: string;
    project_id: string;
    resource_row_id: string;
    plane: ImplementedMemoryV2Plane;
    scopes_json: string;
    source_binding_type: "repository_token_binding" | "harness_principal_binding";
    source_binding_id: string;
    created_at: string;
  };
  const expectedBindingRows = db.prepare(
    `SELECT 'v2bind_repository:' || legacy.binding_id AS binding_id,
            legacy.token_id, legacy.service_principal_id, legacy.org_id,
            legacy.project_id, resource.resource_row_id, 'codebase' AS plane,
            token.scopes_json,
            'repository_token_binding' AS source_binding_type,
            legacy.binding_id AS source_binding_id, legacy.created_at
     FROM memory_service_token_repository_bindings AS legacy
     INNER JOIN service_tokens AS token ON token.token_id = legacy.token_id
     INNER JOIN memory_v2_resources AS resource
       ON resource.source_authority = 'memory_repository_registry'
      AND resource.source_row_id = legacy.repository_row_id
     UNION ALL
     SELECT 'v2bind_harness:' || token.token_id || ':' || legacy.binding_id AS binding_id,
            token.token_id, legacy.service_principal_id, legacy.org_id,
            legacy.project_id, resource.resource_row_id, 'harness' AS plane,
            token.scopes_json,
            'harness_principal_binding' AS source_binding_type,
            legacy.binding_id AS source_binding_id, legacy.created_at
     FROM memory_harness_principal_bindings AS legacy
     INNER JOIN service_tokens AS token
       ON token.service_principal_id = legacy.service_principal_id
      AND token.project_id = legacy.project_id
     INNER JOIN memory_v2_resources AS resource
       ON resource.org_id = legacy.org_id
      AND resource.project_id = legacy.project_id
      AND resource.plane = 'harness'
      AND resource.canonical_resource_id = legacy.harness_id
     ORDER BY binding_id`,
  ).all() as unknown as ExpectedBindingRow[];
  const expectedBindings = expectedBindingRows.flatMap((row) => {
    const operations = memoryV2OperationsForScopes(row.plane, parsedScopes(row.scopes_json));
    if (operations.length === 0) return [];
    return [JSON.stringify({
      binding_id: row.binding_id,
      token_id: row.token_id,
      service_principal_id: row.service_principal_id,
      org_id: row.org_id,
      project_id: row.project_id,
      resource_row_id: row.resource_row_id,
      operations_json: JSON.stringify(operations),
      source_binding_type: row.source_binding_type,
      source_binding_id: row.source_binding_id,
      created_at: row.created_at,
    })];
  });
  const projectedBindings = (db.prepare(
    `SELECT binding_id, token_id, service_principal_id, org_id, project_id,
            resource_row_id, operations_json, source_binding_type,
            source_binding_id, created_at
     FROM memory_v2_service_token_resource_bindings ORDER BY binding_id`,
  ).all() as unknown as Array<Record<string, unknown>>).map((row) => JSON.stringify(row));
  const expectedBindingCount = expectedBindings.length;
  const bindingProjectionCount = count(
    "SELECT COUNT(*) AS count FROM memory_v2_service_token_resource_bindings",
  );
  const bindingIdentityMismatchCount = symmetricProjectionMismatchCount(
    expectedBindings,
    projectedBindings,
  );
  const relevantTables = new Set([
    "memory_v2_resources",
    "memory_v2_resource_aliases",
    "memory_v2_service_token_resource_bindings",
  ]);
  const foreignKeyViolationCount = (db.prepare("PRAGMA foreign_key_check").all() as unknown as Array<{
    table: string;
  }>).filter((row) => relevantTables.has(row.table)).length;
  const ok = repositoryAuthorityCount === repositoryProjectionCount
    && repositoryIdentityMismatchCount === 0
    && harnessAuthorityCount === harnessProjectionCount
    && harnessIdentityMismatchCount === 0
    && aliasAuthorityCount === aliasProjectionCount
    && aliasIdentityMismatchCount === 0
    && expectedBindingCount === bindingProjectionCount
    && bindingIdentityMismatchCount === 0
    && foreignKeyViolationCount === 0;
  return {
    repositoryAuthorityCount,
    repositoryProjectionCount,
    repositoryIdentityMismatchCount,
    harnessAuthorityCount,
    harnessProjectionCount,
    harnessIdentityMismatchCount,
    aliasAuthorityCount,
    aliasProjectionCount,
    aliasIdentityMismatchCount,
    expectedBindingCount,
    bindingProjectionCount,
    bindingIdentityMismatchCount,
    foreignKeyViolationCount,
    ok,
  };
}
