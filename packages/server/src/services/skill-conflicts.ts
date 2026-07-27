import {
  SKILL_MATCHER_VERSION,
  hashNormalizedSkillContent,
  normalizeSkillName,
  type SkillConflictCandidate,
  type SkillConflictKind,
} from "@pim/shared/skill-catalog";
import db from "../db/connection.js";
import {
  ensureExactSkillCatalogSnapshot,
  getLatestReadySnapshot,
  requireSkillCatalogSource,
  SkillCatalogError,
  type SkillCatalogSnapshot,
} from "./skill-catalog.js";
import {
  compileSkillLayout,
  deriveSkillNamespace,
  isSkillCatalogNamespace,
  normalizeCatalogPath,
} from "./skill-catalog-layout.js";
import {
  findRelatedSkills,
  type RelatedSkillResult,
} from "./skill-catalog-search.js";
import { recordSkillCatalogMetric } from "./skill-catalog-metrics.js";

export const MAX_SKILL_CONFLICT_CANDIDATES = 20;
export const MAX_SKILL_CONFLICT_CANDIDATE_BYTES = 256 * 1024;
export const MAX_SKILL_CONFLICT_AGGREGATE_BYTES = 1024 * 1024;
export const SKILL_RELATED_LOOKUP_BUDGET_MS = 5_000;
export const SKILL_CONFLICT_ROUTE_BODY_LIMIT =
  MAX_SKILL_CONFLICT_AGGREGATE_BYTES + 128 * 1024;

interface ExistingCatalogEntry {
  path: string;
  namespace: string;
  blobSha: string;
  normalizedName: string;
  contentHash: string;
}

interface PreparedCandidate extends SkillConflictCandidate {
  normalizedName: string;
  normalizedPath: string;
  normalizedReplacesPath?: string;
  contentHash: string;
}

export interface ExistingSkillConflict {
  kind: Extract<
    SkillConflictKind,
    "exact_path" | "same_namespace_name" | "exact_content"
  >;
  candidateNamespace: string;
  existingNamespace: string;
  existing: {
    name: string;
    path: string;
    blobSha: string;
  };
  reason: string;
}

export interface CandidateSkillConflict {
  kind: Extract<
    SkillConflictKind,
    | "candidate_exact_path"
    | "candidate_same_namespace_name"
    | "candidate_exact_content"
  >;
  candidateNamespace: string;
  existingCandidateNamespace: string;
  existingCandidate: {
    candidateId: string;
    name: string;
    proposedPath: string;
  };
  reason: string;
}

export type DeterministicSkillConflict =
  | ExistingSkillConflict
  | CandidateSkillConflict;

export interface SkillConflictValidationResponse {
  catalog: {
    commitSha: string;
    snapshotState: "entries_ready" | "search_ready";
  };
  matcherVersion: string;
  results: Array<{
    candidateId: string;
    status: "clear" | "conflict_found";
    conflicts: DeterministicSkillConflict[];
    related: RelatedSkillResult[];
  }>;
}

export type SkillConflictValidationOutcome =
  | {
      status: "ready";
      response: SkillConflictValidationResponse;
    }
  | {
      status: "building";
      retryAfterSeconds: number;
    }
  | {
      status: "failed";
      snapshot: SkillCatalogSnapshot;
    };

function prepareCandidates(
  sourceId: string,
  orgId: string,
  candidates: SkillConflictCandidate[],
): PreparedCandidate[] {
  if (candidates.length === 0 || candidates.length > MAX_SKILL_CONFLICT_CANDIDATES) {
    throw new SkillCatalogError(
      `candidates must contain 1-${MAX_SKILL_CONFLICT_CANDIDATES} items`,
    );
  }
  const source = requireSkillCatalogSource(orgId, sourceId);
  const layout = compileSkillLayout(source.layoutRules, source.excludeGlobs);
  const ids = new Set<string>();
  let aggregateBytes = 0;

  return candidates.map((candidate) => {
    if (ids.has(candidate.candidateId)) {
      throw new SkillCatalogError(`Duplicate candidateId: ${candidate.candidateId}`);
    }
    ids.add(candidate.candidateId);
    const bodyBytes = Buffer.byteLength(candidate.body, "utf8");
    aggregateBytes += bodyBytes;
    if (bodyBytes > MAX_SKILL_CONFLICT_CANDIDATE_BYTES) {
      throw new SkillCatalogError(
        `Candidate ${candidate.candidateId} exceeds the ${MAX_SKILL_CONFLICT_CANDIDATE_BYTES}-byte body limit`,
        413,
      );
    }
    if (aggregateBytes > MAX_SKILL_CONFLICT_AGGREGATE_BYTES) {
      throw new SkillCatalogError(
        `Candidate bodies exceed the ${MAX_SKILL_CONFLICT_AGGREGATE_BYTES}-byte aggregate limit`,
        413,
      );
    }
    if (!isSkillCatalogNamespace(candidate.targetNamespace)) {
      throw new SkillCatalogError(
        `Candidate ${candidate.candidateId} has an invalid targetNamespace`,
      );
    }
    const normalizedPath = normalizeCatalogPath(candidate.proposedPath);
    const derivedNamespace = deriveSkillNamespace(normalizedPath, layout);
    if (!derivedNamespace) {
      throw new SkillCatalogError(
        `Candidate ${candidate.candidateId} proposedPath does not match a source layout rule`,
      );
    }
    if (derivedNamespace !== candidate.targetNamespace) {
      throw new SkillCatalogError(
        `Candidate ${candidate.candidateId} targetNamespace must be ${derivedNamespace}`,
      );
    }
    const normalizedName = normalizeSkillName(candidate.name);
    if (!normalizedName) {
      throw new SkillCatalogError(`Candidate ${candidate.candidateId} has no usable name`);
    }
    return {
      ...candidate,
      normalizedName,
      normalizedPath,
      normalizedReplacesPath: candidate.replacesPath
        ? normalizeCatalogPath(candidate.replacesPath)
        : undefined,
      contentHash: hashNormalizedSkillContent(candidate.body),
    };
  });
}

function loadExistingEntries(
  sourceId: string,
  snapshotId: string,
): ExistingCatalogEntry[] {
  const rows = db
    .prepare(
      `SELECT
         e.path,
         e.namespace,
         e.blob_sha,
         b.normalized_name,
         b.content_hash
       FROM skill_catalog_entries e
       INNER JOIN skill_catalog_blobs b
         ON b.source_id = ? AND b.blob_sha = e.blob_sha
       WHERE e.snapshot_id = ?
       ORDER BY e.path`,
    )
    .all(sourceId, snapshotId) as unknown as Array<{
    path: string;
    namespace: string;
    blob_sha: string;
    normalized_name: string;
    content_hash: string;
  }>;
  return rows.map((row) => ({
    path: row.path,
    namespace: row.namespace,
    blobSha: row.blob_sha,
    normalizedName: row.normalized_name,
    contentHash: row.content_hash,
  }));
}

function existingConflict(
  candidate: PreparedCandidate,
  entry: ExistingCatalogEntry,
  kind: ExistingSkillConflict["kind"],
): ExistingSkillConflict {
  const reasons: Record<ExistingSkillConflict["kind"], string> = {
    exact_path: `A cataloged skill already occupies ${candidate.normalizedPath}.`,
    same_namespace_name: `Normalized name '${candidate.normalizedName}' already exists in ${candidate.targetNamespace}.`,
    exact_content: `Normalized content is identical to ${entry.path}.`,
  };
  return {
    kind,
    candidateNamespace: candidate.targetNamespace,
    existingNamespace: entry.namespace,
    existing: {
      name: entry.normalizedName,
      path: entry.path,
      blobSha: entry.blobSha,
    },
    reason: reasons[kind],
  };
}

function candidateConflict(
  candidate: PreparedCandidate,
  other: PreparedCandidate,
  kind: CandidateSkillConflict["kind"],
): CandidateSkillConflict {
  const reasons: Record<CandidateSkillConflict["kind"], string> = {
    candidate_exact_path: `Candidate ${other.candidateId} proposes the same path.`,
    candidate_same_namespace_name: `Candidate ${other.candidateId} has the same normalized name in ${candidate.targetNamespace}.`,
    candidate_exact_content: `Candidate ${other.candidateId} has identical normalized content.`,
  };
  return {
    kind,
    candidateNamespace: candidate.targetNamespace,
    existingCandidateNamespace: other.targetNamespace,
    existingCandidate: {
      candidateId: other.candidateId,
      name: other.normalizedName,
      proposedPath: other.normalizedPath,
    },
    reason: reasons[kind],
  };
}

function validateReadySnapshot(
  sourceId: string,
  snapshot: SkillCatalogSnapshot,
  candidates: PreparedCandidate[],
): SkillConflictValidationResponse {
  if (snapshot.state !== "entries_ready" && snapshot.state !== "search_ready") {
    throw new SkillCatalogError("Catalog snapshot is not ready", 503, "catalog_not_ready");
  }
  const existingEntries = loadExistingEntries(sourceId, snapshot.snapshotId);
  const conflicts = new Map<string, DeterministicSkillConflict[]>(
    candidates.map((candidate) => [candidate.candidateId, []]),
  );

  for (const candidate of candidates) {
    const candidateConflicts = conflicts.get(candidate.candidateId)!;
    for (const entry of existingEntries) {
      if (
        candidate.normalizedReplacesPath &&
        entry.path === candidate.normalizedReplacesPath
      ) {
        continue;
      }
      if (entry.path === candidate.normalizedPath) {
        candidateConflicts.push(existingConflict(candidate, entry, "exact_path"));
      }
      if (
        entry.namespace === candidate.targetNamespace &&
        entry.normalizedName === candidate.normalizedName
      ) {
        candidateConflicts.push(
          existingConflict(candidate, entry, "same_namespace_name"),
        );
      }
      if (entry.contentHash === candidate.contentHash) {
        candidateConflicts.push(existingConflict(candidate, entry, "exact_content"));
      }
    }
  }

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < candidates.length;
      rightIndex += 1
    ) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      const leftConflicts = conflicts.get(left.candidateId)!;
      const rightConflicts = conflicts.get(right.candidateId)!;
      if (left.normalizedPath === right.normalizedPath) {
        leftConflicts.push(candidateConflict(left, right, "candidate_exact_path"));
        rightConflicts.push(candidateConflict(right, left, "candidate_exact_path"));
      }
      if (
        left.targetNamespace === right.targetNamespace &&
        left.normalizedName === right.normalizedName
      ) {
        leftConflicts.push(
          candidateConflict(left, right, "candidate_same_namespace_name"),
        );
        rightConflicts.push(
          candidateConflict(right, left, "candidate_same_namespace_name"),
        );
      }
      if (left.contentHash === right.contentHash) {
        leftConflicts.push(
          candidateConflict(left, right, "candidate_exact_content"),
        );
        rightConflicts.push(
          candidateConflict(right, left, "candidate_exact_content"),
        );
      }
    }
  }

  return {
    catalog: {
      commitSha: snapshot.commitSha,
      snapshotState: snapshot.state,
    },
    matcherVersion: SKILL_MATCHER_VERSION,
    results: candidates.map((candidate) => {
      const candidateConflicts = conflicts.get(candidate.candidateId)!;
      return {
        candidateId: candidate.candidateId,
        status: candidateConflicts.length > 0 ? "conflict_found" : "clear",
        conflicts: candidateConflicts,
        related: [],
      };
    }),
  };
}

function recordValidationMetrics(
  orgId: string,
  sourceId: string,
  response: SkillConflictValidationResponse,
  context?: {
    projectId?: string | null;
    selectionMode?: string;
  },
): void {
  const fields = {
    org_id: orgId,
    source_id: sourceId,
    project_id: context?.projectId ?? null,
    selection_mode: context?.selectionMode ?? "explicit",
    commit_sha: response.catalog.commitSha,
  };
  const outcomes = new Map<string, number>();
  const conflictKinds = new Map<string, number>();
  for (const result of response.results) {
    outcomes.set(result.status, (outcomes.get(result.status) ?? 0) + 1);
    for (const conflict of result.conflicts) {
      conflictKinds.set(
        conflict.kind,
        (conflictKinds.get(conflict.kind) ?? 0) + 1,
      );
    }
  }
  for (const [outcome, count] of outcomes) {
    recordSkillCatalogMetric({
      name: "ValidationOutcome",
      value: count,
      unit: "Count",
      dimensions: { Outcome: outcome },
      fields,
    });
  }
  for (const [kind, count] of conflictKinds) {
    recordSkillCatalogMetric({
      name: "ValidationConflictKind",
      value: count,
      unit: "Count",
      dimensions: { Kind: kind },
      fields,
    });
  }
}

export async function validateSkillConflicts(input: {
  orgId: string;
  sourceId: string;
  baseCommitSha?: string;
  projectId?: string | null;
  selectionMode?: string;
  candidates: SkillConflictCandidate[];
}): Promise<SkillConflictValidationOutcome> {
  const candidates = prepareCandidates(
    input.sourceId,
    input.orgId,
    input.candidates,
  );
  const availability = input.baseCommitSha
    ? ensureExactSkillCatalogSnapshot(
        input.orgId,
        input.sourceId,
        input.baseCommitSha,
      )
    : (() => {
        const snapshot = getLatestReadySnapshot(input.orgId, input.sourceId);
        if (!snapshot) {
          throw new SkillCatalogError(
            "The selected skill catalog has no ready default-branch snapshot",
            503,
            "catalog_not_ready",
          );
        }
        return { status: "ready" as const, snapshot };
      })();
  if (availability.status === "building") return availability;
  if (availability.status === "failed") return availability;

  const response = validateReadySnapshot(
    input.sourceId,
    availability.snapshot,
    candidates,
  );
  recordValidationMetrics(input.orgId, input.sourceId, response, {
    projectId: input.projectId,
    selectionMode: input.selectionMode,
  });
  if (availability.snapshot.state === "search_ready") {
    const notAfterMs = Date.now() + SKILL_RELATED_LOOKUP_BUDGET_MS;
    const relatedByCandidate: RelatedSkillResult[][] = candidates.map(
      () => [],
    );
    const lookups = candidates.map(async (candidate, index) => {
      relatedByCandidate[index] = await findRelatedSkills({
        orgId: input.orgId,
        sourceId: input.sourceId,
        snapshot: availability.snapshot,
        candidate,
        notAfterMs,
      });
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(lookups),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SKILL_RELATED_LOOKUP_BUDGET_MS);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    response.results.forEach((result, index) => {
      result.related = relatedByCandidate[index] ?? [];
    });
  }

  return {
    status: "ready",
    response,
  };
}
