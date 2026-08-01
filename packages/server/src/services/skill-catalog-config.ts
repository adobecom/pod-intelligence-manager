import db, { withTransaction } from "../db/connection.js";
import {
  getLatestReadySnapshot,
  getLatestSearchReadySnapshot,
  listSkillCatalogSources,
  requireSkillCatalogSource,
  SkillCatalogError,
  type SkillCatalogSource,
} from "./skill-catalog.js";

export type SkillCatalogSelectionMode =
  | "explicit"
  | "project"
  | "org_default";

export interface SanitizedSkillCatalogSource {
  sourceId: string;
  displayName: string;
  repository: {
    apiBaseUrl: string;
    owner: string;
    repo: string;
    defaultRef: string;
  };
  enabled: boolean;
  syncStatus: string;
  lastSyncedAt: string | null;
  latestEntriesReadyCommitSha: string | null;
  latestSearchReadyCommitSha: string | null;
  latestIndexedCommitSha: string | null;
}

export interface SkillCatalogConfiguration {
  sources: SanitizedSkillCatalogSource[];
  selection: {
    projectId: string | null;
    orgDefaultSourceId: string | null;
    projectOverrideSourceId: string | null;
    effectiveSourceId: string | null;
    mode: Exclude<SkillCatalogSelectionMode, "explicit"> | "unconfigured";
    effectiveSource: SanitizedSkillCatalogSource | null;
  };
}

export interface ResolvedSkillCatalogSource {
  orgId: string;
  projectId: string | null;
  selectionMode: SkillCatalogSelectionMode;
  source: SkillCatalogSource;
}

function requireProject(orgId: string, projectId: string): void {
  const project = db
    .prepare(
      "SELECT project_id FROM projects WHERE project_id = ? AND org_id = ?",
    )
    .get(projectId, orgId);
  if (!project) {
    throw new SkillCatalogError(
      "Project not found",
      404,
      "project_not_found",
    );
  }
}

function requireOrgSkillCatalogSource(
  orgId: string,
  sourceId: string,
): SkillCatalogSource {
  return requireSkillCatalogSource(orgId, sourceId);
}

export function sanitizeSkillCatalogSource(
  source: SkillCatalogSource,
): SanitizedSkillCatalogSource {
  const entriesReady = getLatestReadySnapshot(source.orgId, source.sourceId);
  const searchReady = getLatestSearchReadySnapshot(
    source.orgId,
    source.sourceId,
  );
  return {
    sourceId: source.sourceId,
    displayName: source.displayName,
    repository: {
      apiBaseUrl: source.apiBaseUrl,
      owner: source.owner,
      repo: source.repo,
      defaultRef: source.defaultRef,
    },
    enabled: source.enabled,
    syncStatus: source.syncStatus,
    lastSyncedAt: source.lastSyncedAt,
    latestEntriesReadyCommitSha: entriesReady?.commitSha ?? null,
    latestSearchReadyCommitSha: searchReady?.commitSha ?? null,
    latestIndexedCommitSha:
      searchReady?.commitSha ?? entriesReady?.commitSha ?? null,
  };
}

function orgDefaultSourceId(orgId: string): string | null {
  const row = db
    .prepare(
      "SELECT source_id FROM skill_catalog_org_defaults WHERE org_id = ?",
    )
    .get(orgId) as { source_id: string } | undefined;
  return row?.source_id ?? null;
}

function projectOverrideSourceId(
  orgId: string,
  projectId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT source_id
       FROM skill_catalog_project_overrides
       WHERE project_id = ? AND org_id = ?`,
    )
    .get(projectId, orgId) as { source_id: string } | undefined;
  return row?.source_id ?? null;
}

export function getSkillCatalogConfiguration(
  orgId: string,
  projectId?: string,
): SkillCatalogConfiguration {
  const normalizedProjectId = projectId?.trim() || null;
  if (normalizedProjectId) requireProject(orgId, normalizedProjectId);

  const sources = listSkillCatalogSources(orgId).map(
    sanitizeSkillCatalogSource,
  );
  const defaultSourceId = orgDefaultSourceId(orgId);
  const overrideSourceId = normalizedProjectId
    ? projectOverrideSourceId(orgId, normalizedProjectId)
    : null;
  const effectiveSourceId = overrideSourceId ?? defaultSourceId;
  const effectiveSource =
    sources.find((source) => source.sourceId === effectiveSourceId) ?? null;

  return {
    sources,
    selection: {
      projectId: normalizedProjectId,
      orgDefaultSourceId: defaultSourceId,
      projectOverrideSourceId: overrideSourceId,
      effectiveSourceId,
      mode: overrideSourceId
        ? "project"
        : defaultSourceId
          ? "org_default"
          : "unconfigured",
      effectiveSource,
    },
  };
}

export function setOrgDefaultSkillCatalogSource(
  orgId: string,
  sourceId: string | null,
): SkillCatalogConfiguration {
  if (sourceId !== null) requireOrgSkillCatalogSource(orgId, sourceId);
  const updatedAt = new Date().toISOString();
  withTransaction(() => {
    if (sourceId === null) {
      db.prepare(
        "DELETE FROM skill_catalog_org_defaults WHERE org_id = ?",
      ).run(orgId);
      return;
    }
    db.prepare(
      `INSERT INTO skill_catalog_org_defaults (org_id, source_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(org_id) DO UPDATE SET
         source_id = excluded.source_id,
         updated_at = excluded.updated_at`,
    ).run(orgId, sourceId, updatedAt);
  });
  return getSkillCatalogConfiguration(orgId);
}

export function setProjectSkillCatalogSource(
  orgId: string,
  projectId: string,
  sourceId: string | null,
): SkillCatalogConfiguration {
  const normalizedProjectId = projectId.trim();
  requireProject(orgId, normalizedProjectId);
  if (sourceId !== null) requireOrgSkillCatalogSource(orgId, sourceId);
  const updatedAt = new Date().toISOString();
  withTransaction(() => {
    if (sourceId === null) {
      db.prepare(
        `DELETE FROM skill_catalog_project_overrides
         WHERE project_id = ? AND org_id = ?`,
      ).run(normalizedProjectId, orgId);
      return;
    }
    db.prepare(
      `INSERT INTO skill_catalog_project_overrides
         (project_id, org_id, source_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         org_id = excluded.org_id,
         source_id = excluded.source_id,
         updated_at = excluded.updated_at`,
    ).run(normalizedProjectId, orgId, sourceId, updatedAt);
  });
  return getSkillCatalogConfiguration(orgId, normalizedProjectId);
}

export function resolveSkillCatalogSource(input: {
  orgId: string;
  projectId?: string;
  sourceId?: string;
}): ResolvedSkillCatalogSource {
  const projectId = input.projectId?.trim() || null;
  if (projectId) requireProject(input.orgId, projectId);

  const explicitSourceId = input.sourceId?.trim();
  if (explicitSourceId) {
    return {
      orgId: input.orgId,
      projectId,
      selectionMode: "explicit",
      source: requireOrgSkillCatalogSource(input.orgId, explicitSourceId),
    };
  }

  if (projectId) {
    const overrideSourceId = projectOverrideSourceId(input.orgId, projectId);
    if (overrideSourceId) {
      return {
        orgId: input.orgId,
        projectId,
        selectionMode: "project",
        source: requireOrgSkillCatalogSource(input.orgId, overrideSourceId),
      };
    }
  }

  const defaultSourceId = orgDefaultSourceId(input.orgId);
  if (defaultSourceId) {
    return {
      orgId: input.orgId,
      projectId,
      selectionMode: "org_default",
      source: requireOrgSkillCatalogSource(input.orgId, defaultSourceId),
    };
  }

  throw new SkillCatalogError(
    "No skill catalog source is configured for this project or organization",
    409,
    "skill_catalog_source_not_configured",
  );
}

export function resolvedSkillCatalogMetadata(
  resolved: ResolvedSkillCatalogSource,
) {
  return {
    sourceId: resolved.source.sourceId,
    displayName: resolved.source.displayName,
    repository: {
      apiBaseUrl: resolved.source.apiBaseUrl,
      owner: resolved.source.owner,
      repo: resolved.source.repo,
      defaultRef: resolved.source.defaultRef,
    },
    selectionMode: resolved.selectionMode,
    projectId: resolved.projectId,
  };
}
