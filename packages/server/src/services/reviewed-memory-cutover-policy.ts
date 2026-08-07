import fs from "node:fs";
import path from "node:path";
import {
  canonicalJsonSha256,
  type CodebaseApplicabilityV1,
} from "@pim/shared";
import type { LegacyGraphInventoryReport } from "./legacy-graph-inventory.js";
import type {
  MemoryLegacyCanonicalMapping,
  MemoryLegacyResolutionManifest,
  MemoryLegacySourceResolution,
} from "./memory-legacy-migration.js";

export type ReviewedLegacyAssertion =
  | "curated"
  | "legacy_snapshot_provenance"
  | "codebase_scope";

export interface ReviewedRepositoryRoute {
  repository_id: string;
  source_contains: string[];
}

export interface ReviewedRepositoryBindingPolicy {
  repository_id: string;
  provider_repository_id: string;
  display_slug: string;
}

export interface ReviewedMemoryCollectionPolicy {
  collection: string;
  org_id: string;
  project_id: string;
  disposition: "active" | "pending_validation";
  assertions: ReviewedLegacyAssertion[];
  default_repository_id: string;
  repository_routes?: ReviewedRepositoryRoute[];
  repository_bindings: ReviewedRepositoryBindingPolicy[];
}

export interface ReviewedMemoryCutoverPolicy {
  schema_version: "pim.memory-reviewed-cutover-policy.v1";
  actor_id: string;
  reviewed_at: string;
  collections: ReviewedMemoryCollectionPolicy[];
}

export interface ReviewedMemoryResolutionSummary {
  graph_nodes_mapped: number;
  active_requested: number;
  pending_requested: number;
  excluded_graph_nodes: number;
  quarantined_sql_rows: number;
  repositories: Record<string, number>;
}

export interface ReviewedMemoryResolutionResult {
  manifest: MemoryLegacyResolutionManifest;
  summary: ReviewedMemoryResolutionSummary;
}

const ALLOWED_ASSERTIONS = new Set<ReviewedLegacyAssertion>([
  "curated",
  "legacy_snapshot_provenance",
  "codebase_scope",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function repositoryId(value: unknown, label: string): string {
  const repository = requiredString(value, label);
  if (!/^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error(`${label} must be a canonical lowercase GitHub repository id`);
  }
  return repository;
}

export function parseReviewedMemoryCutoverPolicy(value: unknown): ReviewedMemoryCutoverPolicy {
  if (!isObject(value) || value.schema_version !== "pim.memory-reviewed-cutover-policy.v1"
      || !Array.isArray(value.collections) || value.collections.length === 0) {
    throw new Error("Cutover policy must use pim.memory-reviewed-cutover-policy.v1 with collections");
  }
  const actorId = requiredString(value.actor_id, "policy.actor_id");
  const reviewedAt = requiredString(value.reviewed_at, "policy.reviewed_at");
  if (!Number.isFinite(Date.parse(reviewedAt))) throw new Error("policy.reviewed_at must be an ISO timestamp");
  const seenOrgs = new Set<string>();
  const collections = value.collections.map((raw, index): ReviewedMemoryCollectionPolicy => {
    if (!isObject(raw)) throw new Error(`policy.collections[${index}] must be an object`);
    const collection = requiredString(raw.collection, `policy.collections[${index}].collection`);
    const orgId = requiredString(raw.org_id, `policy.collections[${index}].org_id`);
    const projectId = requiredString(raw.project_id, `policy.collections[${index}].project_id`);
    if (seenOrgs.has(orgId)) throw new Error(`Duplicate reviewed organization: ${orgId}`);
    seenOrgs.add(orgId);
    if (raw.disposition !== "active" && raw.disposition !== "pending_validation") {
      throw new Error(`policy.collections[${index}].disposition is unsupported`);
    }
    if (!Array.isArray(raw.assertions) || raw.assertions.length === 0
        || new Set(raw.assertions).size !== raw.assertions.length
        || raw.assertions.some((assertion) => typeof assertion !== "string"
          || !ALLOWED_ASSERTIONS.has(assertion as ReviewedLegacyAssertion))) {
      throw new Error(`policy.collections[${index}].assertions are invalid`);
    }
    const assertions = raw.assertions as ReviewedLegacyAssertion[];
    if (!assertions.includes("codebase_scope")) {
      throw new Error(`policy.collections[${index}] must explicitly assert codebase_scope`);
    }
    if (raw.disposition === "active"
        && !["curated", "legacy_snapshot_provenance", "codebase_scope"]
          .every((assertion) => assertions.includes(assertion as ReviewedLegacyAssertion))) {
      throw new Error(`Active collection ${collection} requires all reviewed legacy assertions`);
    }
    const routes = raw.repository_routes === undefined
      ? undefined
      : Array.isArray(raw.repository_routes)
        ? raw.repository_routes.map((route, routeIndex): ReviewedRepositoryRoute => {
          if (!isObject(route) || !Array.isArray(route.source_contains)
              || route.source_contains.length === 0
              || route.source_contains.some((term) => typeof term !== "string" || !term.trim())) {
            throw new Error(`policy.collections[${index}].repository_routes[${routeIndex}] is invalid`);
          }
          return {
            repository_id: repositoryId(
              route.repository_id,
              `policy.collections[${index}].repository_routes[${routeIndex}].repository_id`,
            ),
            source_contains: [...new Set(route.source_contains.map((term) => term.trim().toLowerCase()))],
          };
        })
        : (() => { throw new Error(`policy.collections[${index}].repository_routes must be an array`); })();
    if (!Array.isArray(raw.repository_bindings) || raw.repository_bindings.length === 0) {
      throw new Error(`policy.collections[${index}].repository_bindings must be a non-empty array`);
    }
    const bindings = raw.repository_bindings.map((binding, bindingIndex): ReviewedRepositoryBindingPolicy => {
      if (!isObject(binding)) {
        throw new Error(`policy.collections[${index}].repository_bindings[${bindingIndex}] must be an object`);
      }
      const canonical = repositoryId(
        binding.repository_id,
        `policy.collections[${index}].repository_bindings[${bindingIndex}].repository_id`,
      );
      const providerId = requiredString(
        binding.provider_repository_id,
        `policy.collections[${index}].repository_bindings[${bindingIndex}].provider_repository_id`,
      );
      const displaySlug = requiredString(
        binding.display_slug,
        `policy.collections[${index}].repository_bindings[${bindingIndex}].display_slug`,
      );
      if (!/^\d+$/.test(providerId) || displaySlug.toLowerCase() !== canonical.slice("github.com/".length)) {
        throw new Error(`policy.collections[${index}].repository_bindings[${bindingIndex}] identity is invalid`);
      }
      return { repository_id: canonical, provider_repository_id: providerId, display_slug: displaySlug };
    });
    const routedRepositories = new Set([
      repositoryId(raw.default_repository_id, `policy.collections[${index}].default_repository_id`),
      ...(routes ?? []).map((route) => route.repository_id),
    ]);
    if (new Set(bindings.map((binding) => binding.repository_id)).size !== bindings.length
        || new Set(bindings.map((binding) => binding.provider_repository_id)).size !== bindings.length
        || bindings.some((binding) => !routedRepositories.has(binding.repository_id))
        || [...routedRepositories].some((repository) =>
          !bindings.some((binding) => binding.repository_id === repository))) {
      throw new Error(`policy.collections[${index}] repository routes and bindings must match exactly`);
    }
    return {
      collection,
      org_id: orgId,
      project_id: projectId,
      disposition: raw.disposition,
      assertions,
      default_repository_id: repositoryId(
        raw.default_repository_id,
        `policy.collections[${index}].default_repository_id`,
      ),
      ...(routes ? { repository_routes: routes } : {}),
      repository_bindings: bindings,
    };
  });
  return {
    schema_version: "pim.memory-reviewed-cutover-policy.v1",
    actor_id: actorId,
    reviewed_at: reviewedAt,
    collections,
  };
}

function parseManifest(value: unknown): MemoryLegacyResolutionManifest {
  if (!isObject(value) || value.schema_version !== "pim.memory-legacy-resolution-manifest.v1"
      || typeof value.source_database_sha256 !== "string" || !Array.isArray(value.resolutions)) {
    throw new Error("Resolution template must use pim.memory-legacy-resolution-manifest.v1");
  }
  return structuredClone(value) as unknown as MemoryLegacyResolutionManifest;
}

function parseInventory(value: unknown): LegacyGraphInventoryReport {
  if (!isObject(value) || value.toolVersion !== "legacy-graph-inventory/v1"
      || !Array.isArray(value.snapshots)) {
    throw new Error("Inventory must use legacy-graph-inventory/v1");
  }
  return value as unknown as LegacyGraphInventoryReport;
}

function sourceIdentityText(node: Record<string, unknown>): string {
  const values: string[] = [];
  if (typeof node.source_pod_name === "string") values.push(node.source_pod_name);
  if (typeof node.source_project_name === "string") values.push(node.source_project_name);
  if (Array.isArray(node.provenance)) {
    for (const item of node.provenance) {
      if (!isObject(item)) continue;
      for (const field of ["source", "source_id", "title", "url"] as const) {
        if (typeof item[field] === "string") values.push(item[field]);
      }
    }
  }
  return values.join("\n").toLowerCase();
}

function routeRepository(node: Record<string, unknown>, policy: ReviewedMemoryCollectionPolicy): string {
  const identity = sourceIdentityText(node);
  for (const route of policy.repository_routes ?? []) {
    if (route.source_contains.some((term) => identity.includes(term))) return route.repository_id;
  }
  return policy.default_repository_id;
}

function boundedComponents(node: Record<string, unknown>, collection: string): string[] {
  const components = [...new Set(["scopes", "domains", "topics"].flatMap((field) => {
    const values = node[field];
    return Array.isArray(values)
      ? values.filter((item): item is string => typeof item === "string")
      : [];
  }).map((value) => value.trim()).filter((value) => value.length > 0 && value.length <= 160))].slice(0, 32);
  return components.length > 0 ? components : [`legacy-kg-${collection}`.slice(0, 160)];
}

function mappedKind(type: unknown): MemoryLegacyCanonicalMapping["kind"] | null {
  if (type === "decision") return "decision";
  if (type === "anti_pattern") return "anti_pattern";
  if (type === "test_strategy") return "test_strategy";
  if (type === "pattern" || type === "scope_insight" || type === "resolved_conflict") return "constraint";
  return null;
}

function graphNodesBySourceKey(inventory: LegacyGraphInventoryReport): Map<string, {
  node: Record<string, unknown>;
  orgId: string;
  snapshotSha256: string;
}> {
  const result = new Map<string, { node: Record<string, unknown>; orgId: string; snapshotSha256: string }>();
  for (const snapshot of inventory.snapshots.filter((item) => item.kind === "latest")) {
    const snapshotPath = path.resolve(snapshot.path);
    const graph = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as unknown;
    if (!isObject(graph) || typeof graph.org_id !== "string" || !Array.isArray(graph.nodes)) continue;
    const ids = graph.nodes.filter(isObject).map((node) => node.id).filter((id): id is string => typeof id === "string");
    const duplicateIds = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
    for (const [index, raw] of graph.nodes.entries()) {
      if (!isObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
      const sourceKey = `${snapshotPath}#${encodeURIComponent(raw.id)}${duplicateIds.has(raw.id) ? `@${index}` : ""}`;
      result.set(sourceKey, {
        node: raw,
        orgId: graph.org_id,
        snapshotSha256: `sha256:${snapshot.sha256}`,
      });
    }
  }
  return result;
}

function mappingForNode(input: {
  resolution: MemoryLegacySourceResolution;
  node: Record<string, unknown>;
  snapshotSha256: string;
  collection: ReviewedMemoryCollectionPolicy;
  actorId: string;
  reviewedAt: string;
}): MemoryLegacyCanonicalMapping | null {
  const kind = mappedKind(input.node.type);
  if (!kind || typeof input.node.summary !== "string" || typeof input.node.details !== "string") return null;
  const repository = routeRepository(input.node, input.collection);
  const applicability: CodebaseApplicabilityV1 = {
    repository_id: repository,
    components: boundedComponents(input.node, input.collection.collection),
  };
  const antiPattern = kind === "anti_pattern";
  const digestSuffix = input.resolution.source_payload_digest.slice("sha256:".length);
  return {
    org_id: input.collection.org_id,
    project_id: input.collection.project_id,
    plane: "codebase",
    kind,
    content: {
      summary: input.node.summary,
      details: input.node.details,
      rationale: "Retained from the reviewed legacy knowledge collection during the canonical memory cutover.",
    },
    applicability,
    validation: antiPattern
      ? { strategy: "stable_failure_fingerprint", failure_fingerprint: `legacy:${digestSuffix}` }
      : { strategy: "repository_anchors" },
    exceptions: antiPattern
      ? ["Does not apply when the failure condition described by this memory is absent."]
      : [],
    compatibility: { harness_version_range: "*", workflow_version_range: "*" },
    evidence: [{
      evidence_ref_id: `legacy_review_${digestSuffix.slice(0, 40)}`,
      type: "review",
      digest: input.resolution.source_payload_digest,
      origin_id: `legacy-graph:${input.collection.collection}:${String(input.node.id)}`,
      source_authority: "authorized_review",
    }],
    evidence_summary: { strength: "reviewed", ref_count: 1 },
    freshness: {
      last_confirmed_at: typeof input.node.created_at === "string"
        && Number.isFinite(Date.parse(input.node.created_at))
        ? input.node.created_at
        : input.reviewedAt,
    },
    provenance: {
      extractor_version: "legacy-graph-reviewed-cutover/v1",
      legacy_collection: input.collection.collection,
      legacy_node_id: input.node.id,
      legacy_source_digest: input.resolution.source_payload_digest,
      legacy_operator_review: {
        schema_version: "pim.memory-legacy-operator-review.v1",
        actor_id: input.actorId,
        reviewed_at: input.reviewedAt,
        collection: input.collection.collection,
        org_id: input.collection.org_id,
        project_id: input.collection.project_id,
        repository_id: repository,
        source_kind: input.resolution.source_kind,
        source_key: input.resolution.source_key,
        source_payload_digest: input.resolution.source_payload_digest,
        snapshot_sha256: input.snapshotSha256,
        assertions: input.collection.assertions,
      },
    },
  };
}

export function buildReviewedMemoryResolutionManifest(input: {
  resolutionTemplate: unknown;
  inventoryReport: unknown;
  policy: unknown;
}): ReviewedMemoryResolutionResult {
  const manifest = parseManifest(input.resolutionTemplate);
  const inventory = parseInventory(input.inventoryReport);
  const policy = parseReviewedMemoryCutoverPolicy(input.policy);
  if (manifest.source_database_sha256 !== inventory.database.sha256) {
    throw new Error("Resolution template and inventory database digests differ");
  }
  const collectionByOrg = new Map(policy.collections.map((collection) => [collection.org_id, collection]));
  const graphSources = graphNodesBySourceKey(inventory);
  const summary: ReviewedMemoryResolutionSummary = {
    graph_nodes_mapped: 0,
    active_requested: 0,
    pending_requested: 0,
    excluded_graph_nodes: 0,
    quarantined_sql_rows: 0,
    repositories: {},
  };
  for (const resolution of manifest.resolutions) {
    delete resolution.mapping;
    if (resolution.source_kind !== "graph_node") {
      resolution.disposition = "quarantined";
      resolution.reason_code = "legacy_sql_authority_not_selected";
      summary.quarantined_sql_rows += 1;
      continue;
    }
    const source = graphSources.get(resolution.source_key);
    const collection = source ? collectionByOrg.get(source.orgId) : undefined;
    if (!source || !collection) {
      resolution.disposition = "quarantined";
      resolution.reason_code = source ? "outside_reviewed_cutover_scope" : "graph_source_not_resolved";
      summary.excluded_graph_nodes += 1;
      continue;
    }
    if (canonicalJsonSha256(source.node) !== resolution.source_payload_digest) {
      throw new Error(`Graph payload digest mismatch for ${resolution.source_key}`);
    }
    const mapping = mappingForNode({
      resolution,
      node: source.node,
      snapshotSha256: source.snapshotSha256,
      collection,
      actorId: policy.actor_id,
      reviewedAt: policy.reviewed_at,
    });
    if (!mapping) {
      resolution.disposition = "quarantined";
      resolution.reason_code = "unsupported_legacy_node_shape";
      summary.excluded_graph_nodes += 1;
      continue;
    }
    resolution.disposition = collection.disposition;
    resolution.reason_code = collection.disposition === "active"
      ? "operator_reviewed_collection"
      : "retained_for_canonical_revalidation";
    resolution.mapping = mapping;
    summary.graph_nodes_mapped += 1;
    if (collection.disposition === "active") summary.active_requested += 1;
    else summary.pending_requested += 1;
    const repository = (mapping.applicability as CodebaseApplicabilityV1).repository_id;
    summary.repositories[repository] = (summary.repositories[repository] ?? 0) + 1;
  }
  return { manifest, summary };
}
