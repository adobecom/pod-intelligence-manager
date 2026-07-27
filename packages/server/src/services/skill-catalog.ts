import {
  createHash,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  SKILL_MATCHER_VERSION,
  hashNormalizedSkillContent,
  type SkillCatalogLayoutRule,
} from "@pim/shared/skill-catalog";
import db, { withTransaction } from "../db/connection.js";
import { redactSecrets } from "./secret-scan.js";
import {
  compileSkillLayout,
  deriveSkillNamespace,
  type CompiledSkillLayout,
} from "./skill-catalog-layout.js";
import {
  buildRedactedSkillEmbeddingText,
  parseSkillMarkdown,
} from "./skill-catalog-markdown.js";
import {
  createGitHubSkillCatalogClient,
  type ResolvedGitCommit,
  type SkillCatalogGitClient,
  type SkillCatalogGitClientFactory,
  type SkillCatalogTreeEntry,
} from "./skill-catalog-github.js";
import { recordSkillCatalogMetric } from "./skill-catalog-metrics.js";

export type SkillCatalogSnapshotState =
  | "building"
  | "entries_ready"
  | "search_ready"
  | "failed";

export interface SkillCatalogSource {
  sourceId: string;
  orgId: string;
  displayName: string;
  apiBaseUrl: string;
  owner: string;
  repo: string;
  defaultRef: string;
  layoutRules: SkillCatalogLayoutRule[];
  excludeGlobs: string[];
  credentialAlias: string;
  webhookSecretAlias: string | null;
  enabled: boolean;
  syncStatus: string;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface SkillCatalogSnapshot {
  snapshotId: string;
  orgId: string;
  sourceId: string;
  commitSha: string;
  state: SkillCatalogSnapshotState;
  isDefaultRef: boolean;
  createdAt: string;
}

export interface CreateSkillCatalogSourceInput {
  sourceId?: string;
  displayName: string;
  apiBaseUrl?: string;
  owner: string;
  repo: string;
  defaultRef?: string;
  layoutRules: SkillCatalogLayoutRule[];
  excludeGlobs?: string[];
  credentialAlias: string;
  webhookSecretAlias?: string;
  enabled?: boolean;
}

export interface SkillCatalogSourceRef {
  orgId: string;
  sourceId: string;
}

export type SkillCatalogWebhookSecretResolution =
  | {
      status: "ready";
      orgId: string;
      sourceId: string;
      owner: string;
      repo: string;
      secret: string;
    }
  | {
      status:
        | "disabled"
        | "fingerprint_mismatch"
        | "not_configured"
        | "not_found";
    };

export interface SkillCatalogEntry {
  name: string;
  description: string | null;
  namespace: string;
  path: string;
  blobSha: string;
}

export interface SkillCatalogPage {
  catalog: {
    sourceId: string;
    commitSha: string;
    snapshotState: "entries_ready" | "search_ready";
  };
  entries: SkillCatalogEntry[];
  nextPath: string | null;
}

export class SkillCatalogError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code = "skill_catalog_error",
  ) {
    super(message);
    this.name = "SkillCatalogError";
  }
}

interface SkillCatalogSourceRow {
  source_id: string;
  org_id: string;
  display_name: string;
  api_base_url: string;
  owner: string;
  repo: string;
  default_ref: string;
  layout_rules_json: string;
  exclude_globs_json: string | null;
  credential_alias: string;
  webhook_secret_alias: string | null;
  webhook_secret_hash: string | null;
  enabled: number;
  sync_status: string;
  last_synced_at: string | null;
  created_at: string;
}

interface SkillCatalogSnapshotRow {
  snapshot_id: string;
  org_id: string;
  source_id: string;
  commit_sha: string;
  state: SkillCatalogSnapshotState;
  is_default_ref: number;
  created_at: string;
}

interface ExistingBlobRow {
  blob_sha: string;
  embedding_json: string | null;
  embedding_status: string;
  matcher_version: string;
  redacted_text: string | null;
}

interface PreparedBlob {
  blobSha: string;
  normalizedName: string;
  description: string | null;
  contentHash: string;
  redactedText: string;
}

interface PreparedEntry {
  path: string;
  blobSha: string;
  namespace: string;
}

export interface SnapshotBuildResult {
  state: "entries_ready" | "search_ready" | "failed";
  snapshot: SkillCatalogSnapshot;
  error?: string;
}

export type ExactSnapshotAvailability =
  | { status: "ready"; snapshot: SkillCatalogSnapshot }
  | { status: "building"; retryAfterSeconds: number }
  | { status: "failed"; snapshot: SkillCatalogSnapshot };

const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_PART_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const CREDENTIAL_ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_CATALOG_SKILL_BYTES = 512 * 1024;
const BLOB_FETCH_CONCURRENCY = 8;
const SNAPSHOT_RETRY_AFTER_SECONDS = 2;
const HISTORICAL_SNAPSHOT_RETENTION = 50;

let gitClientFactory: SkillCatalogGitClientFactory = createGitHubSkillCatalogClient;
const inFlightSnapshotBuilds = new Map<string, Promise<SnapshotBuildResult>>();
const defaultRefSyncGenerations = new Map<string, number>();

function parseLayoutRules(raw: string): SkillCatalogLayoutRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillCatalogError("Stored source layout rules are invalid", 500);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (rule) =>
        typeof rule === "object" &&
        rule !== null &&
        typeof (rule as { glob?: unknown }).glob === "string" &&
        typeof (rule as { namespace?: unknown }).namespace === "string",
    )
  ) {
    throw new SkillCatalogError("Stored source layout rules are invalid", 500);
  }
  return parsed as SkillCatalogLayoutRule[];
}

function parseExcludeGlobs(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillCatalogError("Stored source exclude globs are invalid", 500);
  }
  if (!Array.isArray(parsed) || !parsed.every((glob) => typeof glob === "string")) {
    throw new SkillCatalogError("Stored source exclude globs are invalid", 500);
  }
  return parsed;
}

function sourceFromRow(row: SkillCatalogSourceRow): SkillCatalogSource {
  return {
    sourceId: row.source_id,
    orgId: row.org_id,
    displayName: row.display_name,
    apiBaseUrl: row.api_base_url,
    owner: row.owner,
    repo: row.repo,
    defaultRef: row.default_ref,
    layoutRules: parseLayoutRules(row.layout_rules_json),
    excludeGlobs: parseExcludeGlobs(row.exclude_globs_json),
    credentialAlias: row.credential_alias,
    webhookSecretAlias: row.webhook_secret_alias,
    enabled: Boolean(row.enabled),
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}

function snapshotFromRow(row: SkillCatalogSnapshotRow): SkillCatalogSnapshot {
  return {
    snapshotId: row.snapshot_id,
    orgId: row.org_id,
    sourceId: row.source_id,
    commitSha: row.commit_sha,
    state: row.state,
    isDefaultRef: Boolean(row.is_default_ref),
    createdAt: row.created_at,
  };
}

function normalizedApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SkillCatalogError("apiBaseUrl must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new SkillCatalogError(
      "apiBaseUrl must be an HTTPS URL without credentials, query, or fragment",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function validateSourceInput(input: CreateSkillCatalogSourceInput): {
  sourceId: string;
  displayName: string;
  apiBaseUrl: string;
  owner: string;
  repo: string;
  defaultRef: string;
  excludeGlobs: string[];
  credentialAlias: string;
  webhookSecretAlias: string | null;
  webhookSecretFingerprint: string | null;
  enabled: boolean;
} {
  const sourceId = input.sourceId?.trim() || `skill-src-${randomUUID()}`;
  if (!SOURCE_ID_RE.test(sourceId)) {
    throw new SkillCatalogError(
      "sourceId must be 1-128 characters using letters, numbers, dots, underscores, or hyphens",
    );
  }
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 160) {
    throw new SkillCatalogError("displayName must be 1-160 characters");
  }
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  if (!REPO_PART_RE.test(owner) || !REPO_PART_RE.test(repo)) {
    throw new SkillCatalogError("owner and repo must be valid Git repository names");
  }
  const defaultRef = (input.defaultRef ?? "main").trim();
  if (!defaultRef || defaultRef.length > 255 || defaultRef.includes("\0")) {
    throw new SkillCatalogError("defaultRef must be 1-255 characters");
  }
  const credentialAlias = input.credentialAlias.trim();
  if (!CREDENTIAL_ALIAS_RE.test(credentialAlias)) {
    throw new SkillCatalogError("credentialAlias must be a valid environment-variable name");
  }
  const webhookSecretAlias = input.webhookSecretAlias?.trim() || null;
  if (webhookSecretAlias && !CREDENTIAL_ALIAS_RE.test(webhookSecretAlias)) {
    throw new SkillCatalogError(
      "webhookSecretAlias must be a valid environment-variable name",
    );
  }
  let webhookSecretFingerprint: string | null = null;
  if (webhookSecretAlias) {
    const secret = process.env[webhookSecretAlias];
    if (!secret) {
      throw new SkillCatalogError(
        `Webhook secret alias ${webhookSecretAlias} is not configured`,
      );
    }
    webhookSecretFingerprint = createHash("sha256")
      .update(secret, "utf8")
      .digest("hex");
  }
  const excludeGlobs = input.excludeGlobs ?? [];
  compileSkillLayout(input.layoutRules, excludeGlobs);
  return {
    sourceId,
    displayName,
    apiBaseUrl: normalizedApiBaseUrl(input.apiBaseUrl ?? "https://api.github.com"),
    owner,
    repo,
    defaultRef,
    excludeGlobs,
    credentialAlias,
    webhookSecretAlias,
    webhookSecretFingerprint,
    enabled: input.enabled ?? true,
  };
}

export function createSkillCatalogSource(
  orgId: string,
  input: CreateSkillCatalogSourceInput,
): SkillCatalogSource {
  const validated = validateSourceInput(input);
  const existingId = db
    .prepare("SELECT source_id FROM skill_catalog_sources WHERE source_id = ?")
    .get(validated.sourceId);
  if (existingId) {
    throw new SkillCatalogError(`Skill catalog source already exists: ${validated.sourceId}`, 409);
  }
  const existingRepo = db
    .prepare(
      `SELECT source_id FROM skill_catalog_sources
       WHERE org_id = ? AND api_base_url = ? AND owner = ? AND repo = ?`,
    )
    .get(orgId, validated.apiBaseUrl, validated.owner, validated.repo) as
    | { source_id: string }
    | undefined;
  if (existingRepo) {
    throw new SkillCatalogError(
      `Repository is already configured as source ${existingRepo.source_id}`,
      409,
    );
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_catalog_sources
       (source_id, org_id, display_name, api_base_url, owner, repo, default_ref,
        layout_rules_json, exclude_globs_json, credential_alias,
        webhook_secret_alias, webhook_secret_hash, enabled, sync_status,
        last_synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
  ).run(
    validated.sourceId,
    orgId,
    validated.displayName,
    validated.apiBaseUrl,
    validated.owner,
    validated.repo,
    validated.defaultRef,
    JSON.stringify(input.layoutRules),
    validated.excludeGlobs.length > 0 ? JSON.stringify(validated.excludeGlobs) : null,
    validated.credentialAlias,
    validated.webhookSecretAlias,
    validated.webhookSecretFingerprint,
    validated.enabled ? 1 : 0,
    now,
  );
  return getSkillCatalogSource(orgId, validated.sourceId)!;
}

export function configureSkillCatalogWebhookSecret(
  orgId: string,
  sourceId: string,
  webhookSecretAliasValue: string | null,
): SkillCatalogSource {
  requireSkillCatalogSource(orgId, sourceId);
  const webhookSecretAlias = webhookSecretAliasValue?.trim() || null;
  if (webhookSecretAlias && !CREDENTIAL_ALIAS_RE.test(webhookSecretAlias)) {
    throw new SkillCatalogError(
      "webhookSecretAlias must be a valid environment-variable name",
    );
  }
  let fingerprint: string | null = null;
  if (webhookSecretAlias) {
    const secret = process.env[webhookSecretAlias];
    if (!secret) {
      throw new SkillCatalogError(
        `Webhook secret alias ${webhookSecretAlias} is not configured`,
      );
    }
    fingerprint = createHash("sha256").update(secret, "utf8").digest("hex");
  }
  db.prepare(
    `UPDATE skill_catalog_sources
     SET webhook_secret_alias = ?, webhook_secret_hash = ?
     WHERE source_id = ? AND org_id = ?`,
  ).run(webhookSecretAlias, fingerprint, sourceId, orgId);
  return getSkillCatalogSource(orgId, sourceId)!;
}

export function getSkillCatalogSource(
  orgId: string,
  sourceId: string,
): SkillCatalogSource | null {
  const row = db
    .prepare("SELECT * FROM skill_catalog_sources WHERE source_id = ? AND org_id = ?")
    .get(sourceId, orgId) as unknown as SkillCatalogSourceRow | undefined;
  return row ? sourceFromRow(row) : null;
}

export function requireSkillCatalogSource(
  orgId: string,
  sourceId: string,
): SkillCatalogSource {
  const source = getSkillCatalogSource(orgId, sourceId);
  if (!source) {
    throw new SkillCatalogError("Skill catalog source not found", 404, "source_not_found");
  }
  return source;
}

export function listSkillCatalogSources(orgId: string): SkillCatalogSource[] {
  const rows = db
    .prepare(
      "SELECT * FROM skill_catalog_sources WHERE org_id = ? ORDER BY created_at, source_id",
    )
    .all(orgId) as unknown as SkillCatalogSourceRow[];
  return rows.map(sourceFromRow);
}

export function listEnabledSkillCatalogSourceRefs(): SkillCatalogSourceRef[] {
  const rows = db
    .prepare(
      `SELECT org_id, source_id
       FROM skill_catalog_sources
       WHERE enabled = 1
       ORDER BY created_at, source_id`,
    )
    .all() as unknown as Array<{ org_id: string; source_id: string }>;
  return rows.map((row) => ({
    orgId: row.org_id,
    sourceId: row.source_id,
  }));
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Resolves a webhook secret only after confirming that the deployment value
 * still matches the fingerprint captured with the source configuration.
 * Callers intentionally receive no source metadata on any failure state.
 */
export function resolveSkillCatalogWebhookSecret(
  sourceId: string,
): SkillCatalogWebhookSecretResolution {
  const row = db
    .prepare(
      `SELECT source_id, org_id, owner, repo, webhook_secret_alias,
              webhook_secret_hash, enabled
       FROM skill_catalog_sources
       WHERE source_id = ?`,
    )
    .get(sourceId) as
    | {
        source_id: string;
        org_id: string;
        owner: string;
        repo: string;
        webhook_secret_alias: string | null;
        webhook_secret_hash: string | null;
        enabled: number;
      }
    | undefined;
  if (!row) return { status: "not_found" };
  if (!row.enabled) return { status: "disabled" };
  if (!row.webhook_secret_alias || !row.webhook_secret_hash) {
    return { status: "not_configured" };
  }
  const secret = process.env[row.webhook_secret_alias];
  if (!secret) return { status: "not_configured" };
  const fingerprint = createHash("sha256").update(secret, "utf8").digest("hex");
  if (!timingSafeEqualHex(row.webhook_secret_hash, fingerprint)) {
    return { status: "fingerprint_mismatch" };
  }
  return {
    status: "ready",
    orgId: row.org_id,
    sourceId: row.source_id,
    owner: row.owner,
    repo: row.repo,
    secret,
  };
}

function getSnapshot(
  orgId: string,
  sourceId: string,
  commitSha: string,
): SkillCatalogSnapshot | null {
  const row = db
    .prepare(
      `SELECT s.*
       FROM skill_catalog_snapshots s
       INNER JOIN skill_catalog_sources src ON src.source_id = s.source_id
       WHERE s.source_id = ? AND s.commit_sha = ? AND s.org_id = ? AND src.org_id = ?`,
    )
    .get(sourceId, commitSha, orgId, orgId) as unknown as
    | SkillCatalogSnapshotRow
    | undefined;
  return row ? snapshotFromRow(row) : null;
}

function snapshotUsesCurrentMatcher(
  sourceId: string,
  snapshotId: string,
): boolean {
  const stale = db
    .prepare(
      `SELECT 1
       FROM skill_catalog_entries e
       LEFT JOIN skill_catalog_blobs b
         ON b.source_id = ? AND b.blob_sha = e.blob_sha
       WHERE e.snapshot_id = ?
         AND (b.blob_sha IS NULL OR b.matcher_version <> ?)
       LIMIT 1`,
    )
    .get(sourceId, snapshotId, SKILL_MATCHER_VERSION);
  return !stale;
}

export function getLatestReadySnapshot(
  orgId: string,
  sourceId: string,
): SkillCatalogSnapshot | null {
  const row = db
    .prepare(
      `SELECT s.*
       FROM skill_catalog_snapshots s
       INNER JOIN skill_catalog_sources src ON src.source_id = s.source_id
       WHERE s.source_id = ? AND s.org_id = ? AND src.org_id = ?
         AND s.is_default_ref = 1
         AND s.state IN ('entries_ready', 'search_ready')
       ORDER BY s.created_at DESC, s.rowid DESC
       LIMIT 1`,
    )
    .get(sourceId, orgId, orgId) as unknown as SkillCatalogSnapshotRow | undefined;
  return row ? snapshotFromRow(row) : null;
}

export function getLatestSearchReadySnapshot(
  orgId: string,
  sourceId: string,
): SkillCatalogSnapshot | null {
  const row = db
    .prepare(
      `SELECT s.*
       FROM skill_catalog_snapshots s
       INNER JOIN skill_catalog_sources src ON src.source_id = s.source_id
       WHERE s.source_id = ? AND s.org_id = ? AND src.org_id = ?
         AND s.is_default_ref = 1
         AND s.state = 'search_ready'
       ORDER BY s.created_at DESC, s.rowid DESC
       LIMIT 1`,
    )
    .get(sourceId, orgId, orgId) as unknown as SkillCatalogSnapshotRow | undefined;
  return row ? snapshotFromRow(row) : null;
}

export function getSkillCatalogSourceStatus(orgId: string, sourceId: string) {
  const source = requireSkillCatalogSource(orgId, sourceId);
  const entriesReady = getLatestReadySnapshot(orgId, sourceId);
  const searchReady = getLatestSearchReadySnapshot(orgId, sourceId);
  return {
    sourceId: source.sourceId,
    displayName: source.displayName,
    repository: {
      apiBaseUrl: source.apiBaseUrl,
      owner: source.owner,
      repo: source.repo,
      defaultRef: source.defaultRef,
    },
    layoutRules: source.layoutRules,
    excludeGlobs: source.excludeGlobs,
    enabled: source.enabled,
    syncStatus: source.syncStatus,
    lastSyncedAt: source.lastSyncedAt,
    latestEntriesReadyCommitSha: entriesReady?.commitSha ?? null,
    latestSearchReadyCommitSha: searchReady?.commitSha ?? null,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function validateResolvedCommit(
  requestedCommitSha: string,
  resolved: ResolvedGitCommit,
): void {
  if (
    !FULL_GIT_SHA_RE.test(resolved.commitSha) ||
    !FULL_GIT_SHA_RE.test(resolved.treeSha)
  ) {
    throw new SkillCatalogError("Git API returned an invalid commit or tree SHA", 502);
  }
  if (resolved.commitSha.toLowerCase() !== requestedCommitSha.toLowerCase()) {
    throw new SkillCatalogError(
      `Git API resolved ${requestedCommitSha} to a different commit`,
      502,
    );
  }
}

function upsertBuildingSnapshot(
  source: SkillCatalogSource,
  commitSha: string,
): SkillCatalogSnapshot {
  const existing = getSnapshot(source.orgId, source.sourceId, commitSha);
  const snapshotId = existing?.snapshotId ?? `skill-snapshot-${randomUUID()}`;
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO skill_catalog_snapshots
       (snapshot_id, org_id, source_id, commit_sha, state, is_default_ref, created_at)
     VALUES (?, ?, ?, ?, 'building', 0, ?)
     ON CONFLICT(source_id, commit_sha)
     DO UPDATE SET
       state = 'building'`,
  ).run(
    snapshotId,
    source.orgId,
    source.sourceId,
    commitSha,
    createdAt,
  );
  return getSnapshot(source.orgId, source.sourceId, commitSha)!;
}

function selectSkillEntries(
  tree: SkillCatalogTreeEntry[],
  layout: CompiledSkillLayout,
): PreparedEntry[] {
  const entries: PreparedEntry[] = [];
  for (const item of tree) {
    if (item.type !== "blob") continue;
    const namespace = deriveSkillNamespace(item.path, layout);
    if (!namespace) continue;
    if (!item.sha) {
      throw new SkillCatalogError(`Git tree entry ${item.path} omitted its blob SHA`, 502);
    }
    if (item.size !== undefined && item.size > MAX_CATALOG_SKILL_BYTES) {
      throw new SkillCatalogError(
        `Skill file ${item.path} exceeds the ${MAX_CATALOG_SKILL_BYTES}-byte catalog limit`,
        413,
      );
    }
    entries.push({ path: item.path, blobSha: item.sha, namespace });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function prepareNewBlob(
  client: SkillCatalogGitClient,
  entry: PreparedEntry,
): Promise<PreparedBlob> {
  const text = await client.getBlob(entry.blobSha);
  if (Buffer.byteLength(text, "utf8") > MAX_CATALOG_SKILL_BYTES) {
    throw new SkillCatalogError(
      `Skill file ${entry.path} exceeds the ${MAX_CATALOG_SKILL_BYTES}-byte catalog limit`,
      413,
    );
  }
  const parsed = parseSkillMarkdown(entry.path, text);
  if (!parsed.normalizedName) {
    throw new SkillCatalogError(`Skill file ${entry.path} has no usable name`, 422);
  }
  return {
    blobSha: entry.blobSha,
    normalizedName: parsed.normalizedName,
    description: parsed.description
      ? redactSecrets(parsed.description).text
      : null,
    contentHash: hashNormalizedSkillContent(text),
    redactedText: buildRedactedSkillEmbeddingText(entry.path, text),
  };
}

async function performSnapshotBuild(input: {
  source: SkillCatalogSource;
  commitSha: string;
  buildKind: "default" | "exact";
  client?: SkillCatalogGitClient;
  resolvedCommit?: ResolvedGitCommit;
}): Promise<SnapshotBuildResult> {
  const startedAt = Date.now();
  const { source, commitSha } = input;
  const building = upsertBuildingSnapshot(source, commitSha);

  try {
    if (!source.enabled) {
      throw new SkillCatalogError("Skill catalog source is disabled", 409);
    }
    const client = input.client ?? gitClientFactory(source);
    const resolved = input.resolvedCommit ?? (await client.resolveCommit(commitSha));
    validateResolvedCommit(commitSha, resolved);
    const tree = await client.getRecursiveTree(resolved.treeSha);
    const layout = compileSkillLayout(source.layoutRules, source.excludeGlobs);
    const entries = selectSkillEntries(tree, layout);

    const uniqueBlobShas = [...new Set(entries.map((entry) => entry.blobSha))];
    const existingRows =
      uniqueBlobShas.length === 0
        ? []
        : (db
            .prepare(
              `SELECT blob_sha, embedding_json, embedding_status,
                      matcher_version, redacted_text
               FROM skill_catalog_blobs
               WHERE source_id = ? AND blob_sha IN (${uniqueBlobShas.map(() => "?").join(",")})`,
            )
            .all(source.sourceId, ...uniqueBlobShas) as unknown as ExistingBlobRow[]);
    const currentBlobs = new Set(
      existingRows
        .filter((row) => row.matcher_version === SKILL_MATCHER_VERSION)
        .map((row) => row.blob_sha),
    );
    const searchableBlobs = new Set(
      existingRows
        .filter(
          (row) =>
            row.matcher_version === SKILL_MATCHER_VERSION &&
            row.embedding_status === "ready" &&
            Boolean(row.embedding_json) &&
            Boolean(row.redacted_text),
        )
        .map((row) => row.blob_sha),
    );
    const representativeEntry = new Map<string, PreparedEntry>();
    for (const entry of entries) {
      if (!currentBlobs.has(entry.blobSha) && !representativeEntry.has(entry.blobSha)) {
        representativeEntry.set(entry.blobSha, entry);
      }
    }
    const preparedBlobs = await mapWithConcurrency(
      [...representativeEntry.values()],
      BLOB_FETCH_CONCURRENCY,
      (entry) => prepareNewBlob(client, entry),
    );
    const snapshotState: Extract<
      SkillCatalogSnapshotState,
      "entries_ready" | "search_ready"
    > = uniqueBlobShas.every((blobSha) => searchableBlobs.has(blobSha))
      ? "search_ready"
      : "entries_ready";

    const completedAt = new Date().toISOString();
    withTransaction(() => {
      const upsertBlob = db.prepare(
        `INSERT INTO skill_catalog_blobs
           (org_id, source_id, blob_sha, normalized_name, description, content_hash,
            redacted_text, embedding_json, embedding_status, matcher_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?)
         ON CONFLICT(source_id, blob_sha) DO UPDATE SET
           normalized_name = excluded.normalized_name,
           description = excluded.description,
           content_hash = excluded.content_hash,
           redacted_text = excluded.redacted_text,
           embedding_json = NULL,
           embedding_status = 'pending',
           matcher_version = excluded.matcher_version`,
      );
      for (const blob of preparedBlobs) {
        upsertBlob.run(
          source.orgId,
          source.sourceId,
          blob.blobSha,
          blob.normalizedName,
          blob.description,
          blob.contentHash,
          blob.redactedText,
          SKILL_MATCHER_VERSION,
          completedAt,
        );
      }

      if (preparedBlobs.length > 0) {
        const placeholders = preparedBlobs.map(() => "?").join(",");
        db.prepare(
          `UPDATE skill_catalog_snapshots
           SET state = 'entries_ready'
           WHERE source_id = ?
             AND org_id = ?
             AND state = 'search_ready'
             AND EXISTS (
               SELECT 1
               FROM skill_catalog_entries e
               WHERE e.snapshot_id = skill_catalog_snapshots.snapshot_id
                 AND e.blob_sha IN (${placeholders})
             )`,
        ).run(
          source.sourceId,
          source.orgId,
          ...preparedBlobs.map((blob) => blob.blobSha),
        );
      }

      db.prepare("DELETE FROM skill_catalog_entries WHERE snapshot_id = ?").run(
        building.snapshotId,
      );
      const insertEntry = db.prepare(
        `INSERT INTO skill_catalog_entries (snapshot_id, path, blob_sha, namespace)
         VALUES (?, ?, ?, ?)`,
      );
      for (const entry of entries) {
        insertEntry.run(
          building.snapshotId,
          entry.path,
          entry.blobSha,
          entry.namespace,
        );
      }
      db.prepare(
        `UPDATE skill_catalog_snapshots
         SET state = ?
         WHERE snapshot_id = ? AND org_id = ?`,
      ).run(snapshotState, building.snapshotId, source.orgId);
    });

    recordSkillCatalogMetric({
      name: "SnapshotBuildLatency",
      value: Date.now() - startedAt,
      unit: "Milliseconds",
      dimensions: { State: snapshotState },
      fields: {
        build_kind: input.buildKind,
        org_id: source.orgId,
        source_id: source.sourceId,
      },
    });
    return {
      state: snapshotState,
      snapshot: getSnapshot(source.orgId, source.sourceId, commitSha)!,
    };
  } catch (error) {
    db.prepare(
      `UPDATE skill_catalog_snapshots
       SET state = 'failed'
       WHERE snapshot_id = ? AND org_id = ?`,
    ).run(building.snapshotId, source.orgId);
    recordSkillCatalogMetric({
      name: "SnapshotBuildLatency",
      value: Date.now() - startedAt,
      unit: "Milliseconds",
      dimensions: { State: "failed" },
      fields: {
        build_kind: input.buildKind,
        org_id: source.orgId,
        source_id: source.sourceId,
      },
    });
    if (input.buildKind === "exact") {
      recordSkillCatalogMetric({
        name: "ExactShaBuildFailures",
        value: 1,
        unit: "Count",
        fields: {
          org_id: source.orgId,
          source_id: source.sourceId,
        },
      });
    }
    return {
      state: "failed",
      snapshot: getSnapshot(source.orgId, source.sourceId, commitSha)!,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function snapshotBuildKey(sourceId: string, commitSha: string): string {
  return `${sourceId}:${commitSha.toLowerCase()}`;
}

function sourceHasInFlightSnapshotBuild(sourceId: string): boolean {
  const prefix = `${sourceId}:`;
  return [...inFlightSnapshotBuilds.keys()].some((key) =>
    key.startsWith(prefix),
  );
}

function pruneSkillCatalogHistory(
  source: SkillCatalogSource,
  preserveSnapshotId: string | null,
): void {
  const hasInFlightBuild = sourceHasInFlightSnapshotBuild(source.sourceId);
  try {
    withTransaction(() => {
      db.prepare(
        `DELETE FROM skill_catalog_snapshots
         WHERE snapshot_id IN (
           SELECT snapshot_id
           FROM skill_catalog_snapshots
           WHERE source_id = ?
             AND org_id = ?
             AND is_default_ref = 0
             AND (? = 0 OR state <> 'building')
           ORDER BY
             CASE WHEN snapshot_id = ? THEN 0 ELSE 1 END,
             created_at DESC,
             rowid DESC
           LIMIT -1 OFFSET ?
         )`,
      ).run(
        source.sourceId,
        source.orgId,
        hasInFlightBuild ? 1 : 0,
        preserveSnapshotId,
        HISTORICAL_SNAPSHOT_RETENTION,
      );

      // A concurrent build may already have decided to reuse a blob but not
      // written its entries yet. The last completing build performs blob GC.
      if (hasInFlightBuild) return;
      db.prepare(
        `DELETE FROM skill_catalog_blobs
         WHERE source_id = ?
           AND org_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM skill_catalog_entries e
             INNER JOIN skill_catalog_snapshots s
               ON s.snapshot_id = e.snapshot_id
             WHERE s.source_id = skill_catalog_blobs.source_id
               AND s.org_id = skill_catalog_blobs.org_id
               AND e.blob_sha = skill_catalog_blobs.blob_sha
           )`,
      ).run(source.sourceId, source.orgId);
    });
  } catch {
    // Retention maintenance must not turn a completed snapshot unavailable.
  }
}

function launchSnapshotBuild(input: {
  source: SkillCatalogSource;
  commitSha: string;
  buildKind: "default" | "exact";
  client?: SkillCatalogGitClient;
  resolvedCommit?: ResolvedGitCommit;
}): Promise<SnapshotBuildResult> {
  const key = snapshotBuildKey(input.source.sourceId, input.commitSha);
  const active = inFlightSnapshotBuilds.get(key);
  if (active) return active;

  const promise = performSnapshotBuild(input);
  inFlightSnapshotBuilds.set(key, promise);
  recordSkillCatalogMetric({
    name: "SingleFlightQueueDepth",
    value: inFlightSnapshotBuilds.size,
    unit: "Count",
  });
  const cleanup = (result?: SnapshotBuildResult) => {
    if (inFlightSnapshotBuilds.get(key) === promise) {
      inFlightSnapshotBuilds.delete(key);
      recordSkillCatalogMetric({
        name: "SingleFlightQueueDepth",
        value: inFlightSnapshotBuilds.size,
        unit: "Count",
      });
      pruneSkillCatalogHistory(
        input.source,
        result?.snapshot.snapshotId ??
          getSnapshot(
            input.source.orgId,
            input.source.sourceId,
            input.commitSha,
          )?.snapshotId ??
          null,
      );
    }
  };
  void promise.then(
    (result) => cleanup(result),
    () => cleanup(),
  );
  return promise;
}

export function ensureExactSkillCatalogSnapshot(
  orgId: string,
  sourceId: string,
  commitShaValue: string,
): ExactSnapshotAvailability {
  const source = requireSkillCatalogSource(orgId, sourceId);
  const commitSha = commitShaValue.toLowerCase();
  if (!FULL_GIT_SHA_RE.test(commitSha)) {
    throw new SkillCatalogError("baseCommitSha must be a full 40-character Git SHA");
  }
  const snapshot = getSnapshot(orgId, sourceId, commitSha);
  if (
    (snapshot?.state === "entries_ready" ||
      snapshot?.state === "search_ready") &&
    snapshotUsesCurrentMatcher(sourceId, snapshot.snapshotId)
  ) {
    return { status: "ready", snapshot };
  }

  launchSnapshotBuild({ source, commitSha, buildKind: "exact" });
  return { status: "building", retryAfterSeconds: SNAPSHOT_RETRY_AFTER_SECONDS };
}

function nextDefaultRefSyncGeneration(sourceId: string): number {
  const generation = (defaultRefSyncGenerations.get(sourceId) ?? 0) + 1;
  defaultRefSyncGenerations.set(sourceId, generation);
  return generation;
}

function isLatestDefaultRefSync(sourceId: string, generation: number): boolean {
  return defaultRefSyncGenerations.get(sourceId) === generation;
}

function finalizeDefaultRefSync(
  source: SkillCatalogSource,
  generation: number,
  result: SnapshotBuildResult,
): SnapshotBuildResult {
  if (!isLatestDefaultRefSync(source.sourceId, generation)) return result;
  const completedAt = new Date().toISOString();
  if (result.state === "failed") {
    db.prepare(
      `UPDATE skill_catalog_sources
       SET sync_status = 'failed', last_synced_at = ?
       WHERE source_id = ? AND org_id = ?`,
    ).run(completedAt, source.sourceId, source.orgId);
    return result;
  }

  withTransaction(() => {
    db.prepare(
      `UPDATE skill_catalog_snapshots
       SET is_default_ref = CASE WHEN snapshot_id = ? THEN 1 ELSE 0 END
       WHERE source_id = ? AND org_id = ?`,
    ).run(result.snapshot.snapshotId, source.sourceId, source.orgId);
    db.prepare(
      `UPDATE skill_catalog_sources
       SET sync_status = 'ready', last_synced_at = ?
       WHERE source_id = ? AND org_id = ?`,
    ).run(completedAt, source.sourceId, source.orgId);
  });
  const finalized = {
    ...result,
    snapshot: getSnapshot(
      source.orgId,
      source.sourceId,
      result.snapshot.commitSha,
    )!,
  };
  pruneSkillCatalogHistory(source, finalized.snapshot.snapshotId);
  return finalized;
}

export async function syncSkillCatalogSource(
  orgId: string,
  sourceId: string,
): Promise<SnapshotBuildResult> {
  const source = requireSkillCatalogSource(orgId, sourceId);
  if (!source.enabled) {
    throw new SkillCatalogError("Skill catalog source is disabled", 409);
  }
  const generation = nextDefaultRefSyncGeneration(sourceId);
  db.prepare(
    "UPDATE skill_catalog_sources SET sync_status = 'syncing' WHERE source_id = ? AND org_id = ?",
  ).run(sourceId, orgId);

  let client: SkillCatalogGitClient;
  let resolved: ResolvedGitCommit;
  try {
    client = gitClientFactory(source);
    resolved = await client.resolveCommit(source.defaultRef);
    if (
      !FULL_GIT_SHA_RE.test(resolved.commitSha) ||
      !FULL_GIT_SHA_RE.test(resolved.treeSha)
    ) {
      throw new SkillCatalogError("Git API returned an invalid commit or tree SHA", 502);
    }
  } catch (error) {
    if (isLatestDefaultRefSync(sourceId, generation)) {
      db.prepare(
        `UPDATE skill_catalog_sources
         SET sync_status = 'failed', last_synced_at = ?
         WHERE source_id = ? AND org_id = ?`,
      ).run(new Date().toISOString(), sourceId, orgId);
    }
    throw new SkillCatalogError(
      error instanceof Error ? error.message : String(error),
      502,
      "catalog_not_ready",
    );
  }

  const existing = getSnapshot(orgId, sourceId, resolved.commitSha.toLowerCase());
  if (existing?.state === "entries_ready" || existing?.state === "search_ready") {
    return finalizeDefaultRefSync(source, generation, {
      state: existing.state,
      snapshot: existing,
    });
  }

  const result = await launchSnapshotBuild({
    source,
    commitSha: resolved.commitSha.toLowerCase(),
    buildKind: "default",
    client,
    resolvedCommit: {
      commitSha: resolved.commitSha.toLowerCase(),
      treeSha: resolved.treeSha.toLowerCase(),
    },
  });
  return finalizeDefaultRefSync(source, generation, result);
}

export async function waitForSkillCatalogSnapshotBuild(
  sourceId: string,
  commitSha: string,
): Promise<SnapshotBuildResult | null> {
  return inFlightSnapshotBuilds.get(snapshotBuildKey(sourceId, commitSha)) ?? null;
}

export function getSkillCatalogPage(input: {
  orgId: string;
  sourceId: string;
  commitSha?: string;
  namespace?: string;
  afterPath?: string;
  limit: number;
}): SkillCatalogPage {
  requireSkillCatalogSource(input.orgId, input.sourceId);
  const snapshot = input.commitSha
    ? getSnapshot(input.orgId, input.sourceId, input.commitSha.toLowerCase())
    : getLatestReadySnapshot(input.orgId, input.sourceId);
  if (
    !snapshot ||
    (snapshot.state !== "entries_ready" && snapshot.state !== "search_ready")
  ) {
    throw new SkillCatalogError(
      "The requested catalog snapshot is not ready",
      503,
      "catalog_not_ready",
    );
  }

  const conditions = ["e.snapshot_id = ?"];
  const params: Array<string | number | null> = [snapshot.snapshotId];
  if (input.namespace) {
    conditions.push("e.namespace = ?");
    params.push(input.namespace);
  }
  if (input.afterPath) {
    conditions.push("e.path > ?");
    params.push(input.afterPath);
  }
  params.push(input.limit + 1);
  const rows = db
    .prepare(
      `SELECT
         e.path,
         e.namespace,
         e.blob_sha,
         b.normalized_name,
         b.description
       FROM skill_catalog_entries e
       INNER JOIN skill_catalog_blobs b
         ON b.source_id = ? AND b.blob_sha = e.blob_sha
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.path
       LIMIT ?`,
    )
    .all(input.sourceId, ...params) as unknown as Array<{
    path: string;
    namespace: string;
    blob_sha: string;
    normalized_name: string;
    description: string | null;
  }>;
  const hasMore = rows.length > input.limit;
  const visible = hasMore ? rows.slice(0, input.limit) : rows;

  return {
    catalog: {
      sourceId: input.sourceId,
      commitSha: snapshot.commitSha,
      snapshotState: snapshot.state,
    },
    entries: visible.map((row) => ({
      name: row.normalized_name,
      description: row.description,
      namespace: row.namespace,
      path: row.path,
      blobSha: row.blob_sha,
    })),
    nextPath: hasMore ? visible.at(-1)?.path ?? null : null,
  };
}

export function setSkillCatalogGitClientFactoryForTests(
  factory: SkillCatalogGitClientFactory | null,
): void {
  gitClientFactory = factory ?? createGitHubSkillCatalogClient;
}

export function resetSkillCatalogBuildsForTests(): void {
  inFlightSnapshotBuilds.clear();
  defaultRefSyncGenerations.clear();
  gitClientFactory = createGitHubSkillCatalogClient;
}
