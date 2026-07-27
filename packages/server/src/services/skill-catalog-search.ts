import {
  normalizeSkillName,
  type SkillCatalogNamespace,
  type SkillConflictCandidate,
} from "@pim/shared/skill-catalog";
import db from "../db/connection.js";
import {
  cosineSimilarity,
  generateEmbeddingStrict,
  isEmbeddingAvailable,
} from "./embeddings.js";
import { redactSecrets } from "./secret-scan.js";
import {
  getLatestSearchReadySnapshot,
  requireSkillCatalogSource,
  SkillCatalogError,
  type SkillCatalogSnapshot,
} from "./skill-catalog.js";
import {
  createGitHubSkillCatalogClient,
  type SkillCatalogGitClient,
  type SkillCatalogGitClientFactory,
} from "./skill-catalog-github.js";
import { normalizeCatalogPath } from "./skill-catalog-layout.js";
import { buildRedactedSkillEmbeddingText } from "./skill-catalog-markdown.js";
import { recordSkillCatalogMetric } from "./skill-catalog-metrics.js";

export const SKILL_CATALOG_EMBED_DELAY_MS = 1_100;
export const DEFAULT_SKILL_SEARCH_LIMIT = 5;
export const MAX_SKILL_SEARCH_LIMIT = 20;
export const MAX_RELATED_SKILLS = 5;

const EXCERPT_MAX_CHARS = 500;

export interface SkillCatalogSearchDependencies {
  generateEmbedding: (text: string) => Promise<number[]>;
  embeddingAvailable: () => boolean;
  gitClientFactory: SkillCatalogGitClientFactory;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  embeddingDelayMs: number;
}

export interface SkillCatalogEmbeddingBackfillResult {
  available: boolean;
  processed: number;
  hydrated: number;
  ready: number;
  failed: number;
  snapshots: {
    entriesReady: number;
    searchReady: number;
  };
}

export interface SkillSearchResult {
  name: string;
  description: string | null;
  namespace: string;
  path: string;
  blobSha: string;
  similarity: number;
  excerpt: string;
  nameCollision: boolean;
}

export type SkillSearchOutcome =
  | {
      status: "ready";
      catalog: {
        sourceId: string;
        commitSha: string;
        snapshotState: "search_ready";
      };
      results: SkillSearchResult[];
    }
  | {
      status: "unavailable";
      results: [];
    };

export interface RelatedSkillResult {
  name: string;
  namespace: string;
  path: string;
  blobSha: string;
  similarity: number;
  excerpt: string;
}

export type RelatedSkillCandidate = Pick<
  SkillConflictCandidate,
  "name" | "description" | "proposedPath" | "body" | "replacesPath"
>;

interface PendingBlobRow {
  org_id: string;
  source_id: string;
  blob_sha: string;
  normalized_name: string;
  description: string | null;
  redacted_text: string | null;
  path: string;
}

interface CatalogVectorRow {
  path: string;
  namespace: string;
  blobSha: string;
  normalizedName: string;
  description: string | null;
  redactedText: string;
  embedding: number[];
}

const defaultDependencies: SkillCatalogSearchDependencies = {
  generateEmbedding: generateEmbeddingStrict,
  embeddingAvailable: isEmbeddingAvailable,
  gitClientFactory: createGitHubSkillCatalogClient,
  sleep: (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  embeddingDelayMs: SKILL_CATALOG_EMBED_DELAY_MS,
};

let dependencies: SkillCatalogSearchDependencies = {
  ...defaultDependencies,
};
let embeddingQueue: Promise<void> = Promise.resolve();
let lastEmbeddingStartedAt: number | null = null;
let activeBackfill: Promise<SkillCatalogEmbeddingBackfillResult> | null = null;

function finiteVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item): item is number =>
        typeof item === "number" && Number.isFinite(item),
    )
  );
}

function parseEmbeddingJson(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return finiteVector(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Catalog embeddings share a private serial scheduler so backfill, search, and
 * related lookups respect the deployment's roughly one-request-per-second
 * Bedrock allowance without changing the legacy embedding callers.
 */
function scheduleCatalogEmbedding(
  text: string,
  notAfterMs?: number,
): Promise<number[]> {
  const run = embeddingQueue.then(async () => {
    if (notAfterMs !== undefined && dependencies.now() >= notAfterMs) {
      throw new Error("Catalog embedding advisory deadline elapsed");
    }
    if (lastEmbeddingStartedAt !== null) {
      const elapsed = dependencies.now() - lastEmbeddingStartedAt;
      const remaining = dependencies.embeddingDelayMs - elapsed;
      if (remaining > 0) {
        if (
          notAfterMs !== undefined &&
          dependencies.now() + remaining >= notAfterMs
        ) {
          throw new Error("Catalog embedding advisory deadline elapsed");
        }
        await dependencies.sleep(remaining);
      }
    }
    if (notAfterMs !== undefined && dependencies.now() >= notAfterMs) {
      throw new Error("Catalog embedding advisory deadline elapsed");
    }
    lastEmbeddingStartedAt = dependencies.now();
    return dependencies.generateEmbedding(text);
  });
  embeddingQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function pendingBlobRows(): PendingBlobRow[] {
  return db
    .prepare(
      `SELECT
         b.org_id,
         b.source_id,
         b.blob_sha,
         b.normalized_name,
         b.description,
         b.redacted_text,
         MIN(e.path) AS path
       FROM skill_catalog_blobs b
       INNER JOIN skill_catalog_sources src
         ON src.source_id = b.source_id AND src.org_id = b.org_id
       INNER JOIN skill_catalog_snapshots s
         ON s.source_id = b.source_id
        AND s.org_id = b.org_id
        AND s.state IN ('entries_ready', 'search_ready')
       INNER JOIN skill_catalog_entries e
         ON e.snapshot_id = s.snapshot_id AND e.blob_sha = b.blob_sha
       WHERE src.enabled = 1
         AND b.embedding_status IN ('pending', 'failed')
       GROUP BY
         b.org_id,
         b.source_id,
         b.blob_sha,
         b.normalized_name,
         b.description,
         b.redacted_text,
         b.created_at
       ORDER BY b.created_at, b.source_id, b.blob_sha`,
    )
    .all() as unknown as PendingBlobRow[];
}

function markBlobFailed(row: PendingBlobRow): void {
  db.prepare(
    `UPDATE skill_catalog_blobs
     SET embedding_json = NULL, embedding_status = 'failed'
     WHERE org_id = ? AND source_id = ? AND blob_sha = ?`,
  ).run(row.org_id, row.source_id, row.blob_sha);
}

/**
 * Reconcile both directions. A matcher refresh or failed retry can demote a
 * previously searchable snapshot; only snapshots whose every referenced blob
 * is ready remain search-ready.
 */
export function reconcileSkillCatalogSearchReadySnapshots(): {
  entriesReady: number;
  searchReady: number;
} {
  db.prepare(
    `UPDATE skill_catalog_snapshots
     SET state = CASE
       WHEN NOT EXISTS (
         SELECT 1
         FROM skill_catalog_entries e
         LEFT JOIN skill_catalog_blobs b
           ON b.source_id = skill_catalog_snapshots.source_id
          AND b.org_id = skill_catalog_snapshots.org_id
          AND b.blob_sha = e.blob_sha
         WHERE e.snapshot_id = skill_catalog_snapshots.snapshot_id
           AND (
             b.blob_sha IS NULL
             OR b.embedding_status <> 'ready'
             OR b.embedding_json IS NULL
             OR b.redacted_text IS NULL
             OR b.redacted_text = ''
           )
       )
       THEN 'search_ready'
       ELSE 'entries_ready'
     END
     WHERE state IN ('entries_ready', 'search_ready')`,
  ).run();

  const rows = db
    .prepare(
      `SELECT state, COUNT(*) AS count
       FROM skill_catalog_snapshots
       WHERE state IN ('entries_ready', 'search_ready')
       GROUP BY state`,
    )
    .all() as unknown as Array<{ state: string; count: number }>;
  const counts = new Map(rows.map((row) => [row.state, row.count]));
  return {
    entriesReady: counts.get("entries_ready") ?? 0,
    searchReady: counts.get("search_ready") ?? 0,
  };
}

async function performEmbeddingBackfill(): Promise<SkillCatalogEmbeddingBackfillResult> {
  let snapshots = reconcileSkillCatalogSearchReadySnapshots();
  const rows = pendingBlobRows();
  recordSkillCatalogMetric({
    name: "EmbeddingBackfillDepth",
    value: rows.length,
    unit: "Count",
  });
  if (!dependencies.embeddingAvailable()) {
    return {
      available: false,
      processed: 0,
      hydrated: 0,
      ready: 0,
      failed: 0,
      snapshots,
    };
  }

  const clients = new Map<string, SkillCatalogGitClient>();
  let hydrated = 0;
  let ready = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      let redactedText = row.redacted_text?.trim() || "";
      if (!redactedText) {
        const source = requireSkillCatalogSource(row.org_id, row.source_id);
        let client = clients.get(row.source_id);
        if (!client) {
          client = dependencies.gitClientFactory(source);
          clients.set(row.source_id, client);
        }
        const body = await client.getBlob(row.blob_sha);
        redactedText = buildRedactedSkillEmbeddingText(row.path, body, {
          name: row.normalized_name,
          ...(row.description ? { description: row.description } : {}),
        });
        db.prepare(
          `UPDATE skill_catalog_blobs
           SET redacted_text = ?
           WHERE org_id = ? AND source_id = ? AND blob_sha = ?`,
        ).run(redactedText, row.org_id, row.source_id, row.blob_sha);
        hydrated += 1;
      }

      const embedding = await scheduleCatalogEmbedding(redactedText);
      if (!finiteVector(embedding)) {
        throw new Error("Catalog embedding was not a finite vector");
      }
      db.prepare(
        `UPDATE skill_catalog_blobs
         SET redacted_text = ?, embedding_json = ?, embedding_status = 'ready'
         WHERE org_id = ? AND source_id = ? AND blob_sha = ?`,
      ).run(
        redactedText,
        JSON.stringify(embedding),
        row.org_id,
        row.source_id,
        row.blob_sha,
      );
      ready += 1;
    } catch {
      markBlobFailed(row);
      failed += 1;
    }
  }

  snapshots = reconcileSkillCatalogSearchReadySnapshots();
  recordSkillCatalogMetric({
    name: "EmbeddingBackfillFailures",
    value: failed,
    unit: "Count",
  });
  return {
    available: true,
    processed: rows.length,
    hydrated,
    ready,
    failed,
    snapshots,
  };
}

/** Run one global, retryable, in-process single-flight catalog backfill pass. */
export function runSkillCatalogEmbeddingBackfill(): Promise<SkillCatalogEmbeddingBackfillResult> {
  if (activeBackfill) return activeBackfill;

  const promise = performEmbeddingBackfill();
  activeBackfill = promise;
  const cleanup = () => {
    if (activeBackfill === promise) activeBackfill = null;
  };
  void promise.then(cleanup, cleanup);
  return promise;
}

function snapshotExists(input: {
  orgId: string;
  sourceId: string;
  snapshotId: string;
}): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
         FROM skill_catalog_snapshots
         WHERE snapshot_id = ?
           AND source_id = ?
           AND org_id = ?
           AND state = 'search_ready'`,
      )
      .get(input.snapshotId, input.sourceId, input.orgId),
  );
}

function loadSnapshotCorpus(input: {
  orgId: string;
  sourceId: string;
  snapshotId: string;
}): CatalogVectorRow[] | null {
  if (!snapshotExists(input)) return null;
  const rows = db
    .prepare(
      `SELECT
         e.path,
         e.namespace,
         e.blob_sha,
         b.normalized_name,
         b.description,
         b.redacted_text,
         b.embedding_json,
         b.embedding_status
       FROM skill_catalog_entries e
       LEFT JOIN skill_catalog_blobs b
         ON b.source_id = ?
        AND b.org_id = ?
        AND b.blob_sha = e.blob_sha
       WHERE e.snapshot_id = ?
       ORDER BY e.path`,
    )
    .all(input.sourceId, input.orgId, input.snapshotId) as unknown as Array<{
    path: string;
    namespace: string;
    blob_sha: string | null;
    normalized_name: string | null;
    description: string | null;
    redacted_text: string | null;
    embedding_json: string | null;
    embedding_status: string | null;
  }>;

  const corpus: CatalogVectorRow[] = [];
  for (const row of rows) {
    if (
      !row.blob_sha ||
      !row.normalized_name ||
      !row.redacted_text ||
      !row.embedding_json ||
      row.embedding_status !== "ready"
    ) {
      return null;
    }
    const embedding = parseEmbeddingJson(row.embedding_json);
    if (!embedding) return null;
    corpus.push({
      path: row.path,
      namespace: row.namespace,
      blobSha: row.blob_sha,
      normalizedName: row.normalized_name,
      description: row.description,
      redactedText: row.redacted_text,
      embedding,
    });
  }
  return corpus;
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_MAX_CHARS);
}

function scoreCorpus(
  queryEmbedding: number[],
  corpus: CatalogVectorRow[],
  excludedPath?: string,
): Array<CatalogVectorRow & { similarity: number }> | null {
  if (!finiteVector(queryEmbedding)) return null;
  const scored: Array<CatalogVectorRow & { similarity: number }> = [];
  for (const row of corpus) {
    if (excludedPath && row.path === excludedPath) continue;
    if (row.embedding.length !== queryEmbedding.length) return null;
    scored.push({
      ...row,
      similarity: cosineSimilarity(queryEmbedding, row.embedding),
    });
  }
  return scored.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.path.localeCompare(right.path),
  );
}

function unavailableSearch(): SkillSearchOutcome {
  return { status: "unavailable", results: [] };
}

/** Advisory pre-generation search over the latest search-ready snapshot. */
export async function searchSkillCatalog(input: {
  orgId: string;
  sourceId: string;
  query: string;
  tentativeName?: string;
  targetNamespace?: SkillCatalogNamespace;
  limit?: number;
}): Promise<SkillSearchOutcome> {
  requireSkillCatalogSource(input.orgId, input.sourceId);
  const query = input.query.trim();
  if (!query) throw new SkillCatalogError("query must not be empty");
  const limit = input.limit ?? DEFAULT_SKILL_SEARCH_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_SKILL_SEARCH_LIMIT
  ) {
    throw new SkillCatalogError(
      `limit must be an integer from 1-${MAX_SKILL_SEARCH_LIMIT}`,
    );
  }
  const startedAt = dependencies.now();
  const finish = (outcome: SkillSearchOutcome): SkillSearchOutcome => {
    const fields = {
      org_id: input.orgId,
      source_id: input.sourceId,
    };
    recordSkillCatalogMetric({
      name: "SearchLatency",
      value: Math.max(0, dependencies.now() - startedAt),
      unit: "Milliseconds",
      dimensions: { Status: outcome.status },
      fields,
    });
    recordSkillCatalogMetric({
      name: "SearchResultCount",
      value: outcome.results.length,
      unit: "Count",
      dimensions: { Status: outcome.status },
      fields,
    });
    recordSkillCatalogMetric({
      name: "SearchUnavailable",
      value: outcome.status === "unavailable" ? 1 : 0,
      unit: "Count",
      fields,
    });
    return outcome;
  };

  const snapshot = getLatestSearchReadySnapshot(
    input.orgId,
    input.sourceId,
  );
  if (!snapshot) return finish(unavailableSearch());

  try {
    const queryEmbedding = await scheduleCatalogEmbedding(
      redactSecrets(query).text,
    );
    const corpus = loadSnapshotCorpus({
      orgId: input.orgId,
      sourceId: input.sourceId,
      snapshotId: snapshot.snapshotId,
    });
    if (!corpus) return finish(unavailableSearch());
    const scored = scoreCorpus(queryEmbedding, corpus);
    if (!scored) return finish(unavailableSearch());
    const tentativeName = input.tentativeName
      ? normalizeSkillName(input.tentativeName)
      : "";

    return finish({
      status: "ready",
      catalog: {
        sourceId: input.sourceId,
        commitSha: snapshot.commitSha,
        snapshotState: "search_ready",
      },
      results: scored.slice(0, limit).map((row) => ({
        name: row.normalizedName,
        description: row.description,
        namespace: row.namespace,
        path: row.path,
        blobSha: row.blobSha,
        similarity: row.similarity,
        excerpt: excerpt(row.redactedText),
        nameCollision: Boolean(
          tentativeName &&
            input.targetNamespace &&
            row.namespace === input.targetNamespace &&
            row.normalizedName === tentativeName,
        ),
      })),
    });
  } catch {
    return finish(unavailableSearch());
  }
}

/**
 * Advisory related-skill ranking for a caller-pinned exact snapshot. Every
 * failure degrades to an empty list so deterministic validation remains
 * independent of Git-independent embedding availability.
 */
export async function findRelatedSkills(input: {
  orgId: string;
  sourceId: string;
  snapshot: SkillCatalogSnapshot;
  candidate: RelatedSkillCandidate;
  notAfterMs?: number;
}): Promise<RelatedSkillResult[]> {
  if (
    input.snapshot.state !== "search_ready" ||
    input.snapshot.orgId !== input.orgId ||
    input.snapshot.sourceId !== input.sourceId
  ) {
    return [];
  }

  try {
    const embeddingText = buildRedactedSkillEmbeddingText(
      input.candidate.proposedPath,
      input.candidate.body,
      {
        name: input.candidate.name,
        ...(input.candidate.description
          ? { description: input.candidate.description }
          : {}),
      },
    );
    const queryEmbedding = await scheduleCatalogEmbedding(
      embeddingText,
      input.notAfterMs,
    );
    const corpus = loadSnapshotCorpus({
      orgId: input.orgId,
      sourceId: input.sourceId,
      snapshotId: input.snapshot.snapshotId,
    });
    if (!corpus) return [];
    const excludedPath = input.candidate.replacesPath
      ? normalizeCatalogPath(input.candidate.replacesPath)
      : undefined;
    const scored = scoreCorpus(queryEmbedding, corpus, excludedPath);
    if (!scored) return [];

    return scored.slice(0, MAX_RELATED_SKILLS).map((row) => ({
      name: row.normalizedName,
      namespace: row.namespace,
      path: row.path,
      blobSha: row.blobSha,
      similarity: row.similarity,
      excerpt: excerpt(row.redactedText),
    }));
  } catch {
    return [];
  }
}

export function setSkillCatalogSearchDependenciesForTests(
  overrides: Partial<SkillCatalogSearchDependencies> | null,
): void {
  dependencies = {
    ...defaultDependencies,
    ...(overrides ?? {}),
  };
}

export function resetSkillCatalogSearchForTests(): void {
  dependencies = { ...defaultDependencies };
  embeddingQueue = Promise.resolve();
  lastEmbeddingStartedAt = null;
  activeBackfill = null;
}
