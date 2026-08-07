import type { ProjectResources } from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import { getMemoryAuthorityState } from "./memory-authority.js";
import { registerMemoryRepository } from "./memory-repository-registry.js";
import {
  parseReviewedMemoryCutoverPolicy,
  type ReviewedMemoryCutoverPolicy,
} from "./reviewed-memory-cutover-policy.js";

export interface ReviewedRepositoryPreparationReport {
  schema_version: "pim.memory-reviewed-repository-preparation-report.v1";
  actor_id: string;
  prepared_at: string;
  projects: Array<{
    org_id: string;
    project_id: string;
    resources_changed: boolean;
    repositories: Array<{
      repository_row_id: string;
      repository_id: string;
      provider_repository_id: string;
      display_slug: string;
    }>;
  }>;
}

function parseResources(raw: string | null): ProjectResources {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Project resources_json is not an object");
  }
  return parsed as ProjectResources;
}

function prepare(policy: ReviewedMemoryCutoverPolicy): ReviewedRepositoryPreparationReport {
  const authority = getMemoryAuthorityState();
  if (authority.authority !== "legacy" || authority.legacyWritesFrozen) {
    throw new Error("Repository preparation is only permitted before the canonical cutover");
  }
  return withImmediateTransaction(() => {
    const projects: ReviewedRepositoryPreparationReport["projects"] = [];
    for (const collection of policy.collections) {
      const row = db.prepare(
        "SELECT resources_json FROM projects WHERE org_id = ? AND project_id = ?",
      ).get(collection.org_id, collection.project_id) as { resources_json: string | null } | undefined;
      if (!row) throw new Error(`Reviewed project does not exist: ${collection.org_id}/${collection.project_id}`);
      const resources = parseResources(row.resources_json);
      const existingRepos = resources.github?.repos ?? [];
      const canonicalExisting = new Set(existingRepos.map((value) =>
        value.trim().toLowerCase().replace(/^github\.com\//, "").replace(/\/+$/, "")));
      const additions = collection.repository_bindings
        .filter((binding) => !canonicalExisting.has(binding.repository_id.slice("github.com/".length)))
        .map((binding) => binding.display_slug);
      const nextResources: ProjectResources = {
        ...resources,
        github: {
          ...resources.github,
          repos: [...existingRepos, ...additions],
        },
      };
      const resourcesChanged = additions.length > 0;
      if (resourcesChanged) {
        db.prepare(
          "UPDATE projects SET resources_json = ? WHERE org_id = ? AND project_id = ?",
        ).run(JSON.stringify(nextResources), collection.org_id, collection.project_id);
      }
      const repositories = collection.repository_bindings.map((binding) => {
        const registered = registerMemoryRepository({
          orgId: collection.org_id,
          projectId: collection.project_id,
          providerRepositoryId: binding.provider_repository_id,
          repositoryId: binding.repository_id,
          displaySlug: binding.display_slug,
          now: policy.reviewed_at,
        });
        return {
          repository_row_id: registered.repository_row_id,
          repository_id: registered.repository_id,
          provider_repository_id: registered.provider_repository_id,
          display_slug: registered.display_slug,
        };
      });
      projects.push({
        org_id: collection.org_id,
        project_id: collection.project_id,
        resources_changed: resourcesChanged,
        repositories,
      });
    }
    return {
      schema_version: "pim.memory-reviewed-repository-preparation-report.v1",
      actor_id: policy.actor_id,
      prepared_at: policy.reviewed_at,
      projects,
    };
  });
}

export function prepareReviewedMemoryRepositories(value: unknown): ReviewedRepositoryPreparationReport {
  return prepare(parseReviewedMemoryCutoverPolicy(value));
}
