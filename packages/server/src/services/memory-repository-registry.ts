import { randomUUID } from "node:crypto";
import type { ProjectResources } from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import { normalizeRepositoryId } from "./memory-structural-validator.js";
import {
  projectMemoryV2RepositoryAlias,
  projectMemoryV2RepositoryResource,
  synchronizeMemoryV2RepositoryResource,
} from "./memory-v2-resources.js";

export interface MemoryRepositoryBinding {
  repository_row_id: string;
  org_id: string;
  project_id: string;
  provider: "github";
  provider_repository_id: string;
  repository_id: string;
  display_slug: string;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
}

export class MemoryRepositoryBindingError extends Error {
  readonly statusCode = 403;
  readonly code = "resource_binding_mismatch";

  constructor(message = "Repository is not bound to the authenticated project") {
    super(message);
    this.name = "MemoryRepositoryBindingError";
  }
}

export class MemoryRepositoryConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "idempotency_conflict";

  constructor(message: string) {
    super(message);
    this.name = "MemoryRepositoryConflictError";
  }
}

function parseProjectResources(raw: string | null): ProjectResources {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ProjectResources
      : {};
  } catch {
    return {};
  }
}

function configuredRepositoryIds(orgId: string, projectId: string): Set<string> | null {
  const row = db.prepare(
    "SELECT resources_json FROM projects WHERE org_id = ? AND project_id = ?",
  ).get(orgId, projectId) as { resources_json: string | null } | undefined;
  if (!row) return null;
  const resources = parseProjectResources(row.resources_json);
  const result = new Set<string>();
  for (const raw of resources.github?.repos ?? []) {
    const trimmed = raw.trim().toLowerCase().replace(/\/+$/, "");
    const candidate = trimmed.startsWith("github.com/") ? trimmed : `github.com/${trimmed}`;
    const canonical = normalizeRepositoryId(candidate);
    if (canonical === candidate) result.add(canonical);
  }
  return result;
}

function requireConfiguredRepository(orgId: string, projectId: string, repositoryId: string): void {
  const configured = configuredRepositoryIds(orgId, projectId);
  if (!configured || !configured.has(repositoryId)) throw new MemoryRepositoryBindingError();
}

function requireMatchingDisplaySlug(repositoryId: string, displaySlug: string): string {
  const normalized = displaySlug.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized) || normalized.length > 256) {
    throw new MemoryRepositoryConflictError("Display slug must be owner/repository");
  }
  if (normalized.toLowerCase() !== repositoryId.slice("github.com/".length)) {
    throw new MemoryRepositoryConflictError("Display slug must identify the same canonical repository");
  }
  return normalized;
}

function getRegistryRow(repositoryRowId: string): MemoryRepositoryBinding | null {
  return (db.prepare(
    "SELECT * FROM memory_repository_registry WHERE repository_row_id = ?",
  ).get(repositoryRowId) as unknown as MemoryRepositoryBinding | undefined) ?? null;
}

function assertNoIdentityCollision(
  orgId: string,
  repositoryId: string,
  excludingRepositoryRowId?: string,
): void {
  const canonical = db.prepare(
    `SELECT repository_row_id FROM memory_repository_registry
     WHERE org_id = ? AND repository_id = ? AND repository_row_id <> COALESCE(?, '')`,
  ).get(orgId, repositoryId, excludingRepositoryRowId ?? null) as { repository_row_id: string } | undefined;
  const alias = db.prepare(
    `SELECT repository_row_id FROM memory_repository_aliases
     WHERE org_id = ? AND alias_repository_id = ? AND valid_until IS NULL
       AND repository_row_id <> COALESCE(?, '')`,
  ).get(orgId, repositoryId, excludingRepositoryRowId ?? null) as { repository_row_id: string } | undefined;
  if (canonical || alias) {
    throw new MemoryRepositoryConflictError("Repository identity or alias is already assigned to another immutable provider repository");
  }
}

export function registerMemoryRepository(input: {
  orgId: string;
  projectId: string;
  providerRepositoryId: string;
  repositoryId: string;
  displaySlug: string;
  now?: string;
}): MemoryRepositoryBinding {
  const canonical = normalizeRepositoryId(input.repositoryId);
  if (!canonical || canonical !== input.repositoryId) {
    throw new MemoryRepositoryBindingError("Repository ID must be canonical case-folded github.com/owner/repo");
  }
  requireConfiguredRepository(input.orgId, input.projectId, canonical);
  const providerRepositoryId = input.providerRepositoryId.trim();
  const displaySlug = requireMatchingDisplaySlug(canonical, input.displaySlug);
  if (!providerRepositoryId || providerRepositoryId.length > 128) throw new MemoryRepositoryConflictError("Provider repository ID is required");
  const now = input.now ?? new Date().toISOString();

  return withImmediateTransaction(() => {
    const existing = db.prepare(
      "SELECT * FROM memory_repository_registry WHERE org_id = ? AND provider = 'github' AND provider_repository_id = ?",
    ).get(input.orgId, providerRepositoryId) as unknown as MemoryRepositoryBinding | undefined;
    if (existing) {
      if (existing.project_id === input.projectId && existing.repository_id === canonical) {
        projectMemoryV2RepositoryResource(existing.repository_row_id);
        return existing;
      }
      throw new MemoryRepositoryConflictError("Immutable provider repository is already registered; use an explicit rename or transfer");
    }
    assertNoIdentityCollision(input.orgId, canonical);
    const repositoryRowId = `repo_${randomUUID()}`;
    db.prepare(
      `INSERT INTO memory_repository_registry
         (repository_row_id, org_id, project_id, provider, provider_repository_id, repository_id,
          display_slug, valid_from, valid_until, created_at, updated_at)
       VALUES (?, ?, ?, 'github', ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      repositoryRowId,
      input.orgId,
      input.projectId,
      providerRepositoryId,
      canonical,
      displaySlug,
      now,
      now,
      now,
    );
    projectMemoryV2RepositoryResource(repositoryRowId);
    return getRegistryRow(repositoryRowId)!;
  });
}

export function renameMemoryRepository(input: {
  orgId: string;
  providerRepositoryId: string;
  repositoryId: string;
  displaySlug: string;
  now?: string;
}): MemoryRepositoryBinding {
  const canonical = normalizeRepositoryId(input.repositoryId);
  if (!canonical || canonical !== input.repositoryId) throw new MemoryRepositoryBindingError("Repository ID must be canonical");
  const displaySlug = requireMatchingDisplaySlug(canonical, input.displaySlug);
  const now = input.now ?? new Date().toISOString();
  return withImmediateTransaction(() => {
    const current = db.prepare(
      "SELECT * FROM memory_repository_registry WHERE org_id = ? AND provider = 'github' AND provider_repository_id = ?",
    ).get(input.orgId, input.providerRepositoryId) as unknown as MemoryRepositoryBinding | undefined;
    if (!current) throw new MemoryRepositoryBindingError("Repository is not registered in the authenticated organization");
    requireConfiguredRepository(input.orgId, current.project_id, canonical);
    if (current.repository_id === canonical) {
      projectMemoryV2RepositoryResource(current.repository_row_id);
      return current;
    }
    assertNoIdentityCollision(input.orgId, canonical, current.repository_row_id);
    const aliasId = `alias_${randomUUID()}`;
    db.prepare(
      `INSERT INTO memory_repository_aliases
         (alias_id, repository_row_id, org_id, project_id, alias_repository_id, reason,
          valid_from, valid_until, created_at)
       VALUES (?, ?, ?, ?, ?, 'rename', ?, NULL, ?)`,
    ).run(
      aliasId,
      current.repository_row_id,
      input.orgId,
      current.project_id,
      current.repository_id,
      now,
      now,
    );
    db.prepare(
      `UPDATE memory_repository_registry
       SET repository_id = ?, display_slug = ?, updated_at = ?
       WHERE repository_row_id = ?`,
    ).run(canonical, displaySlug, now, current.repository_row_id);
    synchronizeMemoryV2RepositoryResource(current.repository_row_id);
    projectMemoryV2RepositoryAlias(aliasId);
    return getRegistryRow(current.repository_row_id)!;
  });
}

export function transferMemoryRepository(input: {
  orgId: string;
  providerRepositoryId: string;
  projectId: string;
  now?: string;
}): MemoryRepositoryBinding {
  const now = input.now ?? new Date().toISOString();
  return withImmediateTransaction(() => {
    const current = db.prepare(
      "SELECT * FROM memory_repository_registry WHERE org_id = ? AND provider = 'github' AND provider_repository_id = ?",
    ).get(input.orgId, input.providerRepositoryId) as unknown as MemoryRepositoryBinding | undefined;
    if (!current) throw new MemoryRepositoryBindingError("Repository is not registered in the authenticated organization");
    requireConfiguredRepository(input.orgId, input.projectId, current.repository_id);
    if (current.project_id === input.projectId) {
      projectMemoryV2RepositoryResource(current.repository_row_id);
      return current;
    }
    const aliasId = `alias_${randomUUID()}`;
    db.prepare(
      `INSERT INTO memory_repository_aliases
         (alias_id, repository_row_id, org_id, project_id, alias_repository_id, reason,
          valid_from, valid_until, created_at)
       VALUES (?, ?, ?, ?, ?, 'transfer', ?, ?, ?)`,
    ).run(
      aliasId,
      current.repository_row_id,
      input.orgId,
      current.project_id,
      current.repository_id,
      current.valid_from,
      now,
      now,
    );
    // The transfer alias belongs to the pre-transfer scope. Insert its
    // immutable companion while the resource still has that exact scope.
    projectMemoryV2RepositoryAlias(aliasId);
    db.prepare(
      "UPDATE memory_repository_aliases SET project_id = ? WHERE repository_row_id = ? AND valid_until IS NULL",
    ).run(input.projectId, current.repository_row_id);
    db.prepare(
      `UPDATE memory_repository_registry
       SET project_id = ?, valid_from = ?, updated_at = ?
       WHERE repository_row_id = ?`,
    ).run(input.projectId, now, now, current.repository_row_id);
    synchronizeMemoryV2RepositoryResource(current.repository_row_id);
    db.prepare(
      `UPDATE memory_v2_resource_aliases
       SET project_id = ?
       WHERE resource_row_id = ? AND valid_until IS NULL`,
    ).run(
      input.projectId,
      `v2res_repository:${current.repository_row_id}`,
    );
    return getRegistryRow(current.repository_row_id)!;
  });
}

export function resolveMemoryRepository(
  orgId: string,
  projectId: string,
  requestedRepositoryId: string,
): MemoryRepositoryBinding | null {
  const canonical = normalizeRepositoryId(requestedRepositoryId);
  if (!canonical || canonical !== requestedRepositoryId) return null;
  const direct = db.prepare(
    `SELECT * FROM memory_repository_registry
     WHERE org_id = ? AND project_id = ? AND repository_id = ? AND valid_until IS NULL`,
  ).get(orgId, projectId, canonical) as unknown as MemoryRepositoryBinding | undefined;
  const row = direct ?? db.prepare(
    `SELECT registry.*
     FROM memory_repository_aliases alias
     INNER JOIN memory_repository_registry registry
       ON registry.repository_row_id = alias.repository_row_id
     WHERE alias.org_id = ? AND alias.project_id = ? AND alias.alias_repository_id = ?
       AND alias.valid_until IS NULL
       AND registry.org_id = ? AND registry.project_id = ? AND registry.valid_until IS NULL`,
  ).get(orgId, projectId, canonical, orgId, projectId) as unknown as MemoryRepositoryBinding | undefined;
  if (!row) return null;
  const configured = configuredRepositoryIds(orgId, projectId);
  return configured?.has(row.repository_id) ? row : null;
}
