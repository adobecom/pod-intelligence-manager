import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  SKILL_MATCHER_VERSION,
  normalizeSkillName,
  type SkillCatalogLayoutRule,
} from "@pim/shared/skill-catalog";
import db, { withTransaction } from "../db/connection.js";
import { getEmbeddingDimensions } from "./embeddings.js";
import {
  requireSkillCatalogSource,
  SkillCatalogError,
  type SkillCatalogSnapshotState,
  type SkillCatalogSource,
} from "./skill-catalog.js";
import {
  compileSkillLayout,
  deriveSkillNamespace,
  normalizeCatalogPath,
} from "./skill-catalog-layout.js";

export const SKILL_CATALOG_BUNDLE_SCHEMA_VERSION =
  "pim.skill-catalog-bundle.v1";
export const SKILL_CATALOG_BUNDLE_BODY_LIMIT = 64 * 1024 * 1024;

const MAX_BUNDLE_ENTRIES = 50_000;
const MAX_BUNDLE_BLOBS = 50_000;
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const LayoutRuleSchema = z
  .object({
    glob: z.string().min(1).max(500),
    namespace: z.string().min(1).max(160),
  })
  .strict();

const PortableSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(160),
    apiBaseUrl: z.string().url(),
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    defaultRef: z.string().min(1).max(255),
    layoutRules: z.array(LayoutRuleSchema).min(1).max(50),
    excludeGlobs: z.array(z.string().min(1).max(500)).max(100),
  })
  .strict();

const PortableSnapshotSchema = z
  .object({
    commitSha: z.string().regex(FULL_GIT_SHA_RE),
    state: z.enum(["entries_ready", "search_ready"]),
    matcherVersion: z.string().min(1).max(100),
    createdAt: z.string().datetime(),
    entryCount: z.number().int().min(0).max(MAX_BUNDLE_ENTRIES),
    blobCount: z.number().int().min(0).max(MAX_BUNDLE_BLOBS),
    embeddingDimensions: z.number().int().min(1).max(1024).nullable(),
  })
  .strict();

const PortableEntrySchema = z
  .object({
    path: z.string().min(1).max(1_024),
    namespace: z.string().min(1).max(160),
    blobSha: z.string().regex(FULL_GIT_SHA_RE),
  })
  .strict();

const PortableBlobSchema = z
  .object({
    blobSha: z.string().regex(FULL_GIT_SHA_RE),
    normalizedName: z.string().min(1).max(500),
    description: z.string().max(4_000).nullable(),
    contentHash: z.string().regex(SHA256_RE),
    redactedText: z.string().min(1).max(128 * 1024),
    embedding: z.array(z.number().finite()).min(1).max(1024).nullable(),
  })
  .strict();

const SkillCatalogBundleSchema = z
  .object({
    schemaVersion: z.literal(SKILL_CATALOG_BUNDLE_SCHEMA_VERSION),
    exportedAt: z.string().datetime(),
    source: PortableSourceSchema,
    snapshot: PortableSnapshotSchema,
    entries: z.array(PortableEntrySchema).max(MAX_BUNDLE_ENTRIES),
    blobs: z.array(PortableBlobSchema).max(MAX_BUNDLE_BLOBS),
    integrity: z
      .object({
        algorithm: z.literal("sha256"),
        digest: z.string().regex(SHA256_RE),
      })
      .strict(),
  })
  .strict();

export type PortableSkillCatalogSource = z.infer<
  typeof PortableSourceSchema
>;
export type PortableSkillCatalogSnapshot = z.infer<
  typeof PortableSnapshotSchema
>;
export type PortableSkillCatalogEntry = z.infer<
  typeof PortableEntrySchema
>;
export type PortableSkillCatalogBlob = z.infer<typeof PortableBlobSchema>;
export type SkillCatalogBundle = z.infer<typeof SkillCatalogBundleSchema>;

type BundlePayload = Omit<SkillCatalogBundle, "integrity">;

interface SnapshotRow {
  snapshot_id: string;
  commit_sha: string;
  state: SkillCatalogSnapshotState;
  is_default_ref: number;
  created_at: string;
}

interface ExportRow {
  path: string;
  namespace: string;
  blob_sha: string;
  normalized_name: string;
  description: string | null;
  content_hash: string;
  redacted_text: string | null;
  embedding_json: string | null;
  embedding_status: string;
  matcher_version: string;
}

export interface SkillCatalogBundleImportResult {
  sourceId: string;
  commitSha: string;
  snapshotState: "entries_ready" | "search_ready";
  entriesImported: number;
  blobsImported: number;
  embeddingDimensions: number | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function bundleDigest(payload: BundlePayload): string {
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

function payloadFromBundle(bundle: SkillCatalogBundle): BundlePayload {
  const {
    schemaVersion,
    exportedAt,
    source,
    snapshot,
    entries,
    blobs,
  } = bundle;
  return {
    schemaVersion,
    exportedAt,
    source,
    snapshot,
    entries,
    blobs,
  };
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseEmbedding(
  raw: string | null,
  blobSha: string,
): number[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > 1024 ||
      !value.every(
        (item): item is number =>
          typeof item === "number" && Number.isFinite(item),
      )
    ) {
      throw new Error("invalid vector");
    }
    return value;
  } catch {
    throw new SkillCatalogError(
      `Catalog blob ${blobSha} has an invalid stored embedding`,
      500,
    );
  }
}

function portableSource(source: SkillCatalogSource): PortableSkillCatalogSource {
  return {
    sourceId: source.sourceId,
    displayName: source.displayName,
    apiBaseUrl: source.apiBaseUrl,
    owner: source.owner,
    repo: source.repo,
    defaultRef: source.defaultRef,
    layoutRules: source.layoutRules,
    excludeGlobs: source.excludeGlobs,
  };
}

function selectSnapshot(
  orgId: string,
  sourceId: string,
  commitSha?: string,
): SnapshotRow {
  const row = commitSha
    ? (db
        .prepare(
          `SELECT snapshot_id, commit_sha, state, is_default_ref, created_at
           FROM skill_catalog_snapshots
           WHERE org_id = ? AND source_id = ? AND commit_sha = ?`,
        )
        .get(orgId, sourceId, commitSha.toLowerCase()) as
        | SnapshotRow
        | undefined)
    : (db
        .prepare(
          `SELECT snapshot_id, commit_sha, state, is_default_ref, created_at
           FROM skill_catalog_snapshots
           WHERE org_id = ? AND source_id = ? AND is_default_ref = 1
             AND state IN ('entries_ready', 'search_ready')
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`,
        )
        .get(orgId, sourceId) as SnapshotRow | undefined);

  if (
    !row ||
    (row.state !== "entries_ready" && row.state !== "search_ready")
  ) {
    throw new SkillCatalogError(
      "The requested catalog snapshot is not ready for export",
      409,
      "catalog_not_ready",
    );
  }
  return row;
}

/**
 * Export one ready catalog snapshot into a repository- and commit-pinned bundle.
 * The bundle contains only deterministic match data, secret-redacted retrieval
 * text, and optional embeddings. Raw skill Markdown and credentials are omitted.
 */
export function exportSkillCatalogBundle(input: {
  orgId: string;
  sourceId: string;
  commitSha?: string;
}): SkillCatalogBundle {
  const source = requireSkillCatalogSource(input.orgId, input.sourceId);
  const snapshot = selectSnapshot(
    input.orgId,
    input.sourceId,
    input.commitSha,
  );
  const rows = db
    .prepare(
      `SELECT
         e.path,
         e.namespace,
         e.blob_sha,
         b.normalized_name,
         b.description,
         b.content_hash,
         b.redacted_text,
         b.embedding_json,
         b.embedding_status,
         b.matcher_version
       FROM skill_catalog_entries e
       INNER JOIN skill_catalog_blobs b
         ON b.org_id = ? AND b.source_id = ? AND b.blob_sha = e.blob_sha
       WHERE e.snapshot_id = ?
       ORDER BY e.path`,
    )
    .all(input.orgId, input.sourceId, snapshot.snapshot_id) as unknown as
    ExportRow[];
  const storedEntryCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM skill_catalog_entries WHERE snapshot_id = ?",
      )
      .get(snapshot.snapshot_id) as { count: number }
  ).count;
  if (storedEntryCount !== rows.length) {
    throw new SkillCatalogError(
      "Catalog snapshot contains entries without matching blob metadata",
      409,
      "catalog_not_ready",
    );
  }

  const entries: PortableSkillCatalogEntry[] = [];
  const blobsBySha = new Map<string, PortableSkillCatalogBlob>();
  const dimensions = new Set<number>();
  for (const row of rows) {
    if (row.matcher_version !== SKILL_MATCHER_VERSION) {
      throw new SkillCatalogError(
        `Catalog blob ${row.blob_sha} uses stale matcher ${row.matcher_version}`,
        409,
        "catalog_not_ready",
      );
    }
    if (!row.redacted_text) {
      throw new SkillCatalogError(
        `Catalog blob ${row.blob_sha} has no redacted retrieval text`,
        409,
        "catalog_not_ready",
      );
    }
    const embedding =
      row.embedding_status === "ready"
        ? parseEmbedding(row.embedding_json, row.blob_sha)
        : null;
    if (embedding) dimensions.add(embedding.length);
    entries.push({
      path: row.path,
      namespace: row.namespace,
      blobSha: row.blob_sha,
    });
    const existing = blobsBySha.get(row.blob_sha);
    const blob: PortableSkillCatalogBlob = {
      blobSha: row.blob_sha,
      normalizedName: row.normalized_name,
      description: row.description,
      contentHash: row.content_hash,
      redactedText: row.redacted_text,
      embedding,
    };
    if (existing && stableJson(existing) !== stableJson(blob)) {
      throw new SkillCatalogError(
        `Catalog blob ${row.blob_sha} has inconsistent stored metadata`,
        500,
      );
    }
    blobsBySha.set(row.blob_sha, blob);
  }

  if (dimensions.size > 1) {
    throw new SkillCatalogError(
      "Catalog snapshot contains mixed embedding dimensions",
      409,
      "catalog_not_ready",
    );
  }
  const blobs = [...blobsBySha.values()].sort((left, right) =>
    left.blobSha.localeCompare(right.blobSha),
  );
  const allEmbedded = blobs.every((blob) => Boolean(blob.embedding));
  const expectedState = allEmbedded ? "search_ready" : "entries_ready";
  if (snapshot.state !== expectedState) {
    throw new SkillCatalogError(
      `Catalog snapshot state ${snapshot.state} does not match its blob readiness`,
      409,
      "catalog_not_ready",
    );
  }

  const payload: BundlePayload = {
    schemaVersion: SKILL_CATALOG_BUNDLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    source: portableSource(source),
    snapshot: {
      commitSha: snapshot.commit_sha.toLowerCase(),
      state: snapshot.state,
      matcherVersion: SKILL_MATCHER_VERSION,
      createdAt: snapshot.created_at,
      entryCount: entries.length,
      blobCount: blobs.length,
      embeddingDimensions: dimensions.values().next().value ?? null,
    },
    entries,
    blobs,
  };
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      digest: bundleDigest(payload),
    },
  };
}

function parseBundle(value: unknown): SkillCatalogBundle {
  const result = SkillCatalogBundleSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; ");
    throw new SkillCatalogError(
      `Invalid skill catalog bundle${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.data;
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function validateSourceMatch(
  source: SkillCatalogSource,
  portable: PortableSkillCatalogSource,
): void {
  const mismatch =
    source.sourceId !== portable.sourceId ||
    source.apiBaseUrl !== portable.apiBaseUrl.replace(/\/+$/, "") ||
    source.owner.toLowerCase() !== portable.owner.toLowerCase() ||
    source.repo.toLowerCase() !== portable.repo.toLowerCase() ||
    source.defaultRef !== portable.defaultRef ||
    !sameJson(source.layoutRules, portable.layoutRules) ||
    !sameJson(source.excludeGlobs, portable.excludeGlobs);
  if (mismatch) {
    throw new SkillCatalogError(
      "Bundle repository identity or layout does not match the configured catalog source",
      409,
      "bundle_source_mismatch",
    );
  }
}

function validateBundleRelationships(
  source: SkillCatalogSource,
  bundle: SkillCatalogBundle,
): void {
  if (bundle.snapshot.matcherVersion !== SKILL_MATCHER_VERSION) {
    throw new SkillCatalogError(
      `Bundle matcher ${bundle.snapshot.matcherVersion} is incompatible with ${SKILL_MATCHER_VERSION}`,
      409,
      "bundle_matcher_mismatch",
    );
  }
  if (
    bundle.snapshot.entryCount !== bundle.entries.length ||
    bundle.snapshot.blobCount !== bundle.blobs.length
  ) {
    throw new SkillCatalogError("Bundle counts do not match its payload");
  }

  const layout = compileSkillLayout(source.layoutRules, source.excludeGlobs);
  const paths = new Set<string>();
  const referencedBlobShas = new Set<string>();
  for (const entry of bundle.entries) {
    if (normalizeCatalogPath(entry.path) !== entry.path) {
      throw new SkillCatalogError(
        `Bundle entry path is not canonical: ${entry.path}`,
      );
    }
    if (paths.has(entry.path)) {
      throw new SkillCatalogError(`Bundle contains duplicate path ${entry.path}`);
    }
    paths.add(entry.path);
    const derived = deriveSkillNamespace(entry.path, layout);
    if (!derived || derived !== entry.namespace) {
      throw new SkillCatalogError(
        `Bundle entry ${entry.path} has namespace ${entry.namespace}; expected ${derived ?? "none"}`,
      );
    }
    referencedBlobShas.add(entry.blobSha);
  }

  const blobShas = new Set<string>();
  const vectorDimensions = new Set<number>();
  for (const blob of bundle.blobs) {
    if (blobShas.has(blob.blobSha)) {
      throw new SkillCatalogError(
        `Bundle contains duplicate blob ${blob.blobSha}`,
      );
    }
    blobShas.add(blob.blobSha);
    if (
      normalizeSkillName(blob.normalizedName) !== blob.normalizedName ||
      !blob.normalizedName
    ) {
      throw new SkillCatalogError(
        `Bundle blob ${blob.blobSha} has a non-canonical skill name`,
      );
    }
    if (blob.embedding) vectorDimensions.add(blob.embedding.length);
  }
  if (
    referencedBlobShas.size !== blobShas.size ||
    [...referencedBlobShas].some((sha) => !blobShas.has(sha))
  ) {
    throw new SkillCatalogError(
      "Bundle blobs must exactly match the blobs referenced by its entries",
    );
  }
  if (vectorDimensions.size > 1) {
    throw new SkillCatalogError("Bundle contains mixed embedding dimensions");
  }
  const actualDimensions =
    vectorDimensions.values().next().value ?? null;
  if (actualDimensions !== bundle.snapshot.embeddingDimensions) {
    throw new SkillCatalogError(
      "Bundle embedding dimension metadata does not match its vectors",
    );
  }
  if (
    actualDimensions !== null &&
    actualDimensions !== getEmbeddingDimensions()
  ) {
    throw new SkillCatalogError(
      `Bundle embeddings have ${actualDimensions} dimensions; this PIM expects ${getEmbeddingDimensions()}`,
      409,
      "bundle_embedding_mismatch",
    );
  }
  const expectedState = bundle.blobs.every((blob) => Boolean(blob.embedding))
    ? "search_ready"
    : "entries_ready";
  if (bundle.snapshot.state !== expectedState) {
    throw new SkillCatalogError(
      `Bundle snapshot state ${bundle.snapshot.state} does not match its blob readiness`,
    );
  }
}

/**
 * Import a locally built bundle into an existing org-owned source. The source
 * configuration must already exist and match the bundle. Snapshot replacement,
 * blob upserts, entry replacement, and default-ref promotion are atomic.
 */
export function importSkillCatalogBundle(input: {
  orgId: string;
  sourceId: string;
  bundle: unknown;
}): SkillCatalogBundleImportResult {
  const bundle = parseBundle(input.bundle);
  if (bundle.source.sourceId !== input.sourceId) {
    throw new SkillCatalogError(
      "Bundle sourceId does not match the import route",
      409,
      "bundle_source_mismatch",
    );
  }
  const expectedDigest = bundleDigest(payloadFromBundle(bundle));
  if (!safeDigestEqual(bundle.integrity.digest, expectedDigest)) {
    throw new SkillCatalogError(
      "Skill catalog bundle integrity check failed",
      400,
      "bundle_integrity_failed",
    );
  }

  const source = requireSkillCatalogSource(input.orgId, input.sourceId);
  validateSourceMatch(source, bundle.source);
  validateBundleRelationships(source, bundle);

  for (const blob of bundle.blobs) {
    const existing = db
      .prepare(
        `SELECT content_hash
         FROM skill_catalog_blobs
         WHERE org_id = ? AND source_id = ? AND blob_sha = ?`,
      )
      .get(input.orgId, input.sourceId, blob.blobSha) as
      | { content_hash: string }
      | undefined;
    if (existing && existing.content_hash !== blob.contentHash) {
      throw new SkillCatalogError(
        `Existing blob ${blob.blobSha} has a different content hash`,
        409,
        "bundle_blob_collision",
      );
    }
  }

  const existingSnapshot = db
    .prepare(
      `SELECT snapshot_id
       FROM skill_catalog_snapshots
       WHERE org_id = ? AND source_id = ? AND commit_sha = ?`,
    )
    .get(input.orgId, input.sourceId, bundle.snapshot.commitSha) as
    | { snapshot_id: string }
    | undefined;
  const snapshotId =
    existingSnapshot?.snapshot_id ?? `skill-snapshot-${randomUUID()}`;
  const importedAt = new Date().toISOString();

  withTransaction(() => {
    db.prepare(
      `INSERT INTO skill_catalog_snapshots
         (snapshot_id, org_id, source_id, commit_sha, state, is_default_ref, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(source_id, commit_sha) DO UPDATE SET
         state = excluded.state`,
    ).run(
      snapshotId,
      input.orgId,
      input.sourceId,
      bundle.snapshot.commitSha,
      bundle.snapshot.state,
      bundle.snapshot.createdAt,
    );

    const upsertBlob = db.prepare(
      `INSERT INTO skill_catalog_blobs
         (org_id, source_id, blob_sha, normalized_name, description,
          content_hash, redacted_text, embedding_json, embedding_status,
          embedding_attempts, next_retry_at, matcher_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
       ON CONFLICT(source_id, blob_sha) DO UPDATE SET
         normalized_name = excluded.normalized_name,
         description = excluded.description,
         content_hash = excluded.content_hash,
         redacted_text = excluded.redacted_text,
         embedding_json = excluded.embedding_json,
         embedding_status = excluded.embedding_status,
         embedding_attempts = 0,
         next_retry_at = NULL,
         matcher_version = excluded.matcher_version`,
    );
    for (const blob of bundle.blobs) {
      upsertBlob.run(
        input.orgId,
        input.sourceId,
        blob.blobSha,
        blob.normalizedName,
        blob.description,
        blob.contentHash,
        blob.redactedText,
        blob.embedding ? JSON.stringify(blob.embedding) : null,
        blob.embedding ? "ready" : "pending",
        SKILL_MATCHER_VERSION,
        importedAt,
      );
    }

    db.prepare("DELETE FROM skill_catalog_entries WHERE snapshot_id = ?").run(
      snapshotId,
    );
    const insertEntry = db.prepare(
      `INSERT INTO skill_catalog_entries
         (snapshot_id, path, blob_sha, namespace)
       VALUES (?, ?, ?, ?)`,
    );
    for (const entry of bundle.entries) {
      insertEntry.run(
        snapshotId,
        entry.path,
        entry.blobSha,
        entry.namespace,
      );
    }

    db.prepare(
      `UPDATE skill_catalog_snapshots
       SET is_default_ref = CASE WHEN snapshot_id = ? THEN 1 ELSE 0 END
       WHERE org_id = ? AND source_id = ?`,
    ).run(snapshotId, input.orgId, input.sourceId);
    db.prepare(
      `UPDATE skill_catalog_sources
       SET sync_status = 'ready', last_synced_at = ?
       WHERE org_id = ? AND source_id = ?`,
    ).run(importedAt, input.orgId, input.sourceId);
  });

  return {
    sourceId: input.sourceId,
    commitSha: bundle.snapshot.commitSha,
    snapshotState: bundle.snapshot.state,
    entriesImported: bundle.entries.length,
    blobsImported: bundle.blobs.length,
    embeddingDimensions: bundle.snapshot.embeddingDimensions,
  };
}
