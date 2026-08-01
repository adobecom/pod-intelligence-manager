import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return { testDb: database };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

import { createTables } from "../../db/schema.js";
import {
  findRelatedSkills,
  resetSkillCatalogEmbeddingRetries,
  resetSkillCatalogSearchForTests,
  runSkillCatalogEmbeddingBackfill,
  searchSkillCatalog,
  setSkillCatalogSearchDependenciesForTests,
  SKILL_CATALOG_EMBED_MAX_ATTEMPTS,
  SKILL_CATALOG_EMBED_RETRY_BASE_MS,
} from "../skill-catalog-search.js";
import type { SkillCatalogSnapshot } from "../skill-catalog.js";
import type {
  ResolvedGitCommit,
  SkillCatalogGitClient,
  SkillCatalogTreeEntry,
} from "../skill-catalog-github.js";

const ORG_A = "org-search-a";
const ORG_B = "org-search-b";
let sequence = 0;

class FakeGitClient implements SkillCatalogGitClient {
  readonly blobs = new Map<string, string>();
  readonly blobCalls: string[] = [];

  async resolveCommit(_ref: string): Promise<ResolvedGitCommit> {
    throw new Error("resolveCommit is not used by embedding backfill");
  }

  async getRecursiveTree(_treeSha: string): Promise<SkillCatalogTreeEntry[]> {
    throw new Error("getRecursiveTree is not used by embedding backfill");
  }

  async getBlob(blobSha: string): Promise<string> {
    this.blobCalls.push(blobSha);
    const body = this.blobs.get(blobSha);
    if (body === undefined) throw new Error(`missing blob ${blobSha}`);
    return body;
  }
}

function nextTimestamp(): string {
  sequence += 1;
  return `2026-07-25T00:00:${String(sequence).padStart(2, "0")}.000Z`;
}

function seedOrg(orgId: string): void {
  const userId = `user-${orgId}`;
  const now = nextTimestamp();
  testDb
    .prepare("INSERT INTO users (user_id, email, created_at) VALUES (?, ?, ?)")
    .run(userId, `${userId}@example.com`, now);
  testDb
    .prepare(
      "INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(orgId, orgId, orgId, userId, now);
}

function seedSource(orgId: string, sourceId: string): void {
  const now = nextTimestamp();
  testDb
    .prepare(
      `INSERT INTO skill_catalog_sources
         (source_id, org_id, display_name, api_base_url, owner, repo, default_ref,
          layout_rules_json, exclude_globs_json, credential_alias,
          webhook_secret_alias, webhook_secret_hash, enabled, sync_status,
          last_synced_at, created_at)
       VALUES (?, ?, ?, 'https://api.github.com', 'Adobe-acom', ?, 'main',
               ?, NULL, 'TEST_GITHUB_TOKEN', NULL, NULL, 1, 'ready', ?, ?)`,
    )
    .run(
      sourceId,
      orgId,
      sourceId,
      `repo-${sourceId}`,
      JSON.stringify([
        {
          glob: "projects/*/skills/**/*.md",
          namespace: "project:{1}",
        },
        { glob: "shared/skills/**/*.md", namespace: "shared" },
      ]),
      now,
      now,
    );
}

function seedSnapshot(input: {
  orgId: string;
  sourceId: string;
  snapshotId: string;
  commitChar: string;
  state: "entries_ready" | "search_ready";
  isDefaultRef?: boolean;
  createdAt?: string;
}): SkillCatalogSnapshot {
  const createdAt = input.createdAt ?? nextTimestamp();
  const commitSha = input.commitChar.repeat(40);
  testDb
    .prepare(
      `INSERT INTO skill_catalog_snapshots
         (snapshot_id, org_id, source_id, commit_sha, state, is_default_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.snapshotId,
      input.orgId,
      input.sourceId,
      commitSha,
      input.state,
      input.isDefaultRef === false ? 0 : 1,
      createdAt,
    );
  return {
    snapshotId: input.snapshotId,
    orgId: input.orgId,
    sourceId: input.sourceId,
    commitSha,
    state: input.state,
    isDefaultRef: input.isDefaultRef !== false,
    createdAt,
  };
}

function seedBlob(input: {
  orgId: string;
  sourceId: string;
  snapshotId: string;
  blobSha: string;
  path: string;
  namespace: string;
  name: string;
  description?: string | null;
  redactedText?: string | null;
  embedding?: number[] | null;
  status?: "pending" | "ready" | "failed";
  attempts?: number;
  nextRetryAt?: string | null;
}): void {
  const status = input.status ?? (input.embedding ? "ready" : "pending");
  testDb
    .prepare(
      `INSERT OR IGNORE INTO skill_catalog_blobs
         (org_id, source_id, blob_sha, normalized_name, description, content_hash,
          redacted_text, embedding_json, embedding_status, embedding_attempts,
          next_retry_at, matcher_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1', ?)`,
    )
    .run(
      input.orgId,
      input.sourceId,
      input.blobSha,
      input.name,
      input.description ?? null,
      `hash-${input.blobSha}`,
      input.redactedText ?? null,
      input.embedding ? JSON.stringify(input.embedding) : null,
      status,
      input.attempts ?? 0,
      input.nextRetryAt ?? null,
      nextTimestamp(),
    );
  testDb
    .prepare(
      `INSERT INTO skill_catalog_entries (snapshot_id, path, blob_sha, namespace)
       VALUES (?, ?, ?, ?)`,
    )
    .run(input.snapshotId, input.path, input.blobSha, input.namespace);
}

function blobRow(sourceId: string, blobSha: string) {
  return testDb
    .prepare(
      `SELECT redacted_text, embedding_json, embedding_status,
              embedding_attempts, next_retry_at
       FROM skill_catalog_blobs
       WHERE source_id = ? AND blob_sha = ?`,
    )
    .get(sourceId, blobSha) as {
    redacted_text: string | null;
    embedding_json: string | null;
    embedding_status: string;
    embedding_attempts: number;
    next_retry_at: string | null;
  };
}

function snapshotState(snapshotId: string): string {
  return (
    testDb
      .prepare(
        "SELECT state FROM skill_catalog_snapshots WHERE snapshot_id = ?",
      )
      .get(snapshotId) as { state: string }
  ).state;
}

beforeAll(() => {
  createTables();
  seedOrg(ORG_A);
  seedOrg(ORG_B);
});

afterEach(() => {
  resetSkillCatalogSearchForTests();
  testDb.prepare("DELETE FROM skill_catalog_sources").run();
});

afterAll(() => {
  testDb.close();
});

describe("skill catalog embedding backfill", () => {
  it("single-flights, hydrates legacy text, redacts it, paces embeddings, and marks snapshots ready", async () => {
    const sourceId = "source-backfill";
    const snapshotId = "snapshot-backfill";
    const legacySha = "a".repeat(40);
    const currentSha = "b".repeat(40);
    seedSource(ORG_A, sourceId);
    seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      commitChar: "1",
      state: "entries_ready",
    });
    seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId: "snapshot-empty",
      commitChar: "2",
      state: "entries_ready",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      blobSha: legacySha,
      path: "projects/team/skills/legacy.md",
      namespace: "project:team",
      name: "legacy-review",
      description: 'Use token = "catalog-secret-value" for review.',
      redactedText: null,
      status: "pending",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      blobSha: currentSha,
      path: "shared/skills/current.md",
      namespace: "shared",
      name: "current-review",
      description: "Current review",
      redactedText: "current review\nCurrent Review\nChecks current work.",
      status: "pending",
    });

    const git = new FakeGitClient();
    git.blobs.set(
      legacySha,
      [
        "# Legacy Review",
        "",
        "FULL INSTRUCTION BODY MUST NOT LEAVE PIM.",
        "",
        "## Workflow",
      ].join("\n"),
    );
    const embeddedTexts: string[] = [];
    const sleeps: number[] = [];
    let now = 0;
    setSkillCatalogSearchDependenciesForTests({
      embeddingAvailable: () => true,
      gitClientFactory: () => git,
      generateEmbedding: async (text) => {
        embeddedTexts.push(text);
        return text.startsWith("legacy") ? [1, 0] : [0, 1];
      },
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      embeddingDelayMs: 1_100,
    });

    const first = runSkillCatalogEmbeddingBackfill();
    const joined = runSkillCatalogEmbeddingBackfill();
    expect(joined).toBe(first);
    const result = await first;

    expect(result).toEqual({
      available: true,
      processed: 2,
      hydrated: 1,
      ready: 2,
      failed: 0,
      snapshots: { entriesReady: 0, searchReady: 2 },
    });
    expect(git.blobCalls).toEqual([legacySha]);
    expect(sleeps).toEqual([1_100]);
    expect(embeddedTexts).toHaveLength(2);
    expect(embeddedTexts[0]).toContain("legacy review");
    expect(embeddedTexts[0]).toContain("Legacy Review");
    expect(embeddedTexts[0]).toContain("Workflow");
    expect(embeddedTexts[0]).toContain("[REDACTED:Generic Secret]");
    expect(embeddedTexts[0]).not.toContain("catalog-secret-value");
    expect(embeddedTexts[0]).not.toContain("FULL INSTRUCTION BODY");

    const legacy = blobRow(sourceId, legacySha);
    expect(legacy.embedding_status).toBe("ready");
    expect(JSON.parse(legacy.embedding_json!)).toEqual([1, 0]);
    expect(legacy.redacted_text).toBe(embeddedTexts[0]);
    expect(snapshotState(snapshotId)).toBe("search_ready");
    expect(snapshotState("snapshot-empty")).toBe("search_ready");
  });

  it("demotes an incomplete snapshot, backs failures off, and retries them when due", async () => {
    const sourceId = "source-retry";
    const snapshotId = "snapshot-retry";
    const blobSha = "c".repeat(40);
    seedSource(ORG_A, sourceId);
    seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      commitChar: "3",
      state: "search_ready",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      blobSha,
      path: "shared/skills/retry.md",
      namespace: "shared",
      name: "retry",
      redactedText: "retry\nRetry embedding",
      status: "failed",
    });

    const embed = vi
      .fn<(text: string) => Promise<number[]>>()
      .mockRejectedValueOnce(new Error("Bedrock unavailable"))
      .mockResolvedValueOnce([1, 0]);
    let now = Date.parse("2026-07-25T12:00:00.000Z");
    setSkillCatalogSearchDependenciesForTests({
      embeddingAvailable: () => true,
      generateEmbedding: embed,
      embeddingDelayMs: 0,
      now: () => now,
    });

    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      processed: 1,
      ready: 0,
      failed: 1,
      snapshots: { entriesReady: 1, searchReady: 0 },
    });
    expect(blobRow(sourceId, blobSha)).toMatchObject({
      embedding_status: "failed",
      embedding_attempts: 1,
      next_retry_at: new Date(
        now + SKILL_CATALOG_EMBED_RETRY_BASE_MS,
      ).toISOString(),
    });
    expect(snapshotState(snapshotId)).toBe("entries_ready");

    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      processed: 0,
      ready: 0,
      failed: 0,
    });
    expect(embed).toHaveBeenCalledTimes(1);

    now += SKILL_CATALOG_EMBED_RETRY_BASE_MS;
    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      processed: 1,
      ready: 1,
      failed: 0,
      snapshots: { entriesReady: 0, searchReady: 1 },
    });
    expect(blobRow(sourceId, blobSha)).toMatchObject({
      embedding_status: "ready",
      embedding_json: JSON.stringify([1, 0]),
      embedding_attempts: 0,
      next_retry_at: null,
    });
    expect(snapshotState(snapshotId)).toBe("search_ready");
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("backs off hydration failures without repeatedly fetching the blob", async () => {
    const sourceId = "source-hydration-retry";
    const snapshotId = "snapshot-hydration-retry";
    const blobSha = "e".repeat(40);
    seedSource(ORG_A, sourceId);
    seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      commitChar: "5",
      state: "entries_ready",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      blobSha,
      path: "shared/skills/missing.md",
      namespace: "shared",
      name: "missing",
      redactedText: null,
      status: "pending",
    });

    const git = new FakeGitClient();
    let now = Date.parse("2026-07-25T12:00:00.000Z");
    setSkillCatalogSearchDependenciesForTests({
      embeddingAvailable: () => true,
      gitClientFactory: () => git,
      now: () => now,
    });

    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });
    expect(git.blobCalls).toEqual([blobSha]);

    now += SKILL_CATALOG_EMBED_RETRY_BASE_MS - 1;
    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      processed: 0,
      failed: 0,
    });
    expect(git.blobCalls).toEqual([blobSha]);

    now += 1;
    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });
    expect(git.blobCalls).toEqual([blobSha, blobSha]);
    expect(blobRow(sourceId, blobSha)).toMatchObject({
      embedding_attempts: 2,
      next_retry_at: new Date(
        now + SKILL_CATALOG_EMBED_RETRY_BASE_MS * 2,
      ).toISOString(),
    });
  });

  it("caps consecutive failures and lets an explicit retry recover", async () => {
    const sourceId = "source-exhausted";
    const snapshotId = "snapshot-exhausted";
    const blobSha = "f".repeat(40);
    seedSource(ORG_A, sourceId);
    seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      commitChar: "6",
      state: "entries_ready",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      blobSha,
      path: "shared/skills/exhausted.md",
      namespace: "shared",
      name: "exhausted",
      redactedText: "exhausted",
      status: "failed",
      attempts: SKILL_CATALOG_EMBED_MAX_ATTEMPTS - 1,
    });

    const embed = vi
      .fn<(text: string) => Promise<number[]>>()
      .mockRejectedValueOnce(new Error("permanent failure"))
      .mockResolvedValueOnce([1, 0]);
    setSkillCatalogSearchDependenciesForTests({
      embeddingAvailable: () => true,
      generateEmbedding: embed,
      embeddingDelayMs: 0,
    });

    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });
    expect(blobRow(sourceId, blobSha)).toMatchObject({
      embedding_status: "failed",
      embedding_attempts: SKILL_CATALOG_EMBED_MAX_ATTEMPTS,
      next_retry_at: null,
    });

    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      processed: 0,
      failed: 0,
    });
    expect(embed).toHaveBeenCalledTimes(1);

    expect(resetSkillCatalogEmbeddingRetries(ORG_A, sourceId)).toBe(1);
    expect(blobRow(sourceId, blobSha)).toMatchObject({
      embedding_status: "pending",
      embedding_attempts: 0,
      next_retry_at: null,
    });
    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      processed: 1,
      ready: 1,
    });
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("leaves pending work retryable when embeddings are not configured", async () => {
    const sourceId = "source-unconfigured";
    const snapshotId = "snapshot-unconfigured";
    const blobSha = "d".repeat(40);
    seedSource(ORG_A, sourceId);
    seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      commitChar: "4",
      state: "entries_ready",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId,
      blobSha,
      path: "shared/skills/pending.md",
      namespace: "shared",
      name: "pending",
      redactedText: "pending",
      status: "pending",
    });
    const embed = vi.fn();
    setSkillCatalogSearchDependenciesForTests({
      embeddingAvailable: () => false,
      generateEmbedding: embed,
    });

    await expect(runSkillCatalogEmbeddingBackfill()).resolves.toMatchObject({
      available: false,
      processed: 0,
    });
    expect(blobRow(sourceId, blobSha).embedding_status).toBe("pending");
    expect(snapshotState(snapshotId)).toBe("entries_ready");
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("pre-generation skill search", () => {
  it("uses the latest search-ready SHA, ranks with a stable tie-break, and flags only same-namespace names", async () => {
    const sourceId = "source-search";
    seedSource(ORG_A, sourceId);
    seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId: "snapshot-old",
      commitChar: "5",
      state: "search_ready",
      createdAt: "2026-07-25T01:00:00.000Z",
    });
    const latest = seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId: "snapshot-latest",
      commitChar: "6",
      state: "search_ready",
      createdAt: "2026-07-25T02:00:00.000Z",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId: "snapshot-old",
      blobSha: "e".repeat(40),
      path: "shared/skills/old.md",
      namespace: "shared",
      name: "old",
      redactedText: "old",
      embedding: [1, 0],
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId: latest.snapshotId,
      blobSha: "f".repeat(40),
      path: "projects/other/skills/a-review.md",
      namespace: "project:other",
      name: "review-pr",
      description: "Other review",
      redactedText: "review pr\nOther Review",
      embedding: [1, 0],
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId: latest.snapshotId,
      blobSha: "1".repeat(40),
      path: "projects/team/skills/z-review.md",
      namespace: "project:team",
      name: "review-pr",
      description: "Team review",
      redactedText: "review pr\nTeam Review",
      embedding: [1, 0],
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId: latest.snapshotId,
      blobSha: "2".repeat(40),
      path: "shared/skills/unrelated.md",
      namespace: "shared",
      name: "unrelated",
      redactedText: "unrelated",
      embedding: [0, 1],
    });

    const foreignSource = "source-foreign";
    seedSource(ORG_B, foreignSource);
    const foreign = seedSnapshot({
      orgId: ORG_B,
      sourceId: foreignSource,
      snapshotId: "snapshot-foreign",
      commitChar: "7",
      state: "search_ready",
    });
    seedBlob({
      orgId: ORG_B,
      sourceId: foreignSource,
      snapshotId: foreign.snapshotId,
      blobSha: "3".repeat(40),
      path: "projects/team/skills/foreign.md",
      namespace: "project:team",
      name: "review-pr",
      redactedText: "foreign",
      embedding: [1, 0],
    });

    const embeddedTexts: string[] = [];
    setSkillCatalogSearchDependenciesForTests({
      generateEmbedding: async (text) => {
        embeddedTexts.push(text);
        return [1, 0];
      },
      embeddingDelayMs: 0,
    });
    const before = testDb
      .prepare(
        "SELECT source_id, blob_sha, embedding_status, embedding_json FROM skill_catalog_blobs ORDER BY source_id, blob_sha",
      )
      .all();

    const outcome = await searchSkillCatalog({
      orgId: ORG_A,
      sourceId,
      query: 'Find token = "query-secret-value" pull request reviews',
      tentativeName: "Review_PR.md",
      targetNamespace: "project:team",
      limit: 3,
    });

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("expected ready search");
    expect(outcome.catalog).toEqual({
      sourceId,
      commitSha: latest.commitSha,
      snapshotState: "search_ready",
    });
    expect(outcome.results.map((result) => result.path)).toEqual([
      "projects/other/skills/a-review.md",
      "projects/team/skills/z-review.md",
      "shared/skills/unrelated.md",
    ]);
    expect(outcome.results.map((result) => result.nameCollision)).toEqual([
      false,
      true,
      false,
    ]);
    expect(outcome.results[0].similarity).toBeCloseTo(1);
    expect(JSON.stringify(outcome)).not.toContain('"clear"');
    expect(JSON.stringify(outcome)).not.toContain("foreign.md");
    expect(embeddedTexts).toEqual([
      "Find [REDACTED:Generic Secret] pull request reviews",
    ]);
    expect(embeddedTexts[0]).not.toContain("query-secret-value");
    const after = testDb
      .prepare(
        "SELECT source_id, blob_sha, embedding_status, embedding_json FROM skill_catalog_blobs ORDER BY source_id, blob_sha",
      )
      .all();
    expect(after).toEqual(before);
  });

  it("returns unavailable without persisting on missing snapshots or embedding failures", async () => {
    const sourceId = "source-search-unavailable";
    seedSource(ORG_A, sourceId);
    const embed = vi.fn().mockRejectedValue(new Error("Bedrock down"));
    setSkillCatalogSearchDependenciesForTests({
      generateEmbedding: embed,
      embeddingDelayMs: 0,
    });

    await expect(
      searchSkillCatalog({
        orgId: ORG_A,
        sourceId,
        query: "review",
      }),
    ).resolves.toEqual({ status: "unavailable", results: [] });
    expect(embed).not.toHaveBeenCalled();

    const snapshot = seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId: "snapshot-search-failure",
      commitChar: "8",
      state: "search_ready",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId: snapshot.snapshotId,
      blobSha: "4".repeat(40),
      path: "shared/skills/review.md",
      namespace: "shared",
      name: "review",
      redactedText: "review",
      embedding: [1, 0],
    });

    await expect(
      searchSkillCatalog({
        orgId: ORG_A,
        sourceId,
        query: "review",
      }),
    ).resolves.toEqual({ status: "unavailable", results: [] });
    await expect(
      searchSkillCatalog({
        orgId: ORG_B,
        sourceId,
        query: "review",
      }),
    ).rejects.toMatchObject({ code: "source_not_found" });
  });
});

describe("related skills for exact snapshots", () => {
  it("uses the explicit snapshot, excludes the replaced path, caps at five, and persists no candidate data", async () => {
    const sourceId = "source-related";
    seedSource(ORG_A, sourceId);
    const explicit = seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId: "snapshot-explicit",
      commitChar: "9",
      state: "search_ready",
      createdAt: "2026-07-25T03:00:00.000Z",
    });
    const replacedPath = "projects/team/skills/00-self.md";
    const paths = [
      replacedPath,
      ...Array.from(
        { length: 6 },
        (_, index) =>
          `projects/team/skills/${String(index + 1).padStart(2, "0")}.md`,
      ),
    ];
    paths.forEach((path, index) => {
      seedBlob({
        orgId: ORG_A,
        sourceId,
        snapshotId: explicit.snapshotId,
        blobSha: String(index + 1).repeat(40),
        path,
        namespace: "project:team",
        name: `skill-${index}`,
        redactedText: `skill ${index}\nSafe excerpt ${index}`,
        embedding: [1, 0],
      });
    });
    const latest = seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId: "snapshot-newer-unrelated",
      commitChar: "a",
      state: "search_ready",
      createdAt: "2026-07-25T04:00:00.000Z",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId: latest.snapshotId,
      blobSha: "b".repeat(40),
      path: "shared/skills/newer.md",
      namespace: "shared",
      name: "newer",
      redactedText: "newer",
      embedding: [1, 0],
    });

    const embeddedTexts: string[] = [];
    setSkillCatalogSearchDependenciesForTests({
      generateEmbedding: async (text) => {
        embeddedTexts.push(text);
        return [1, 0];
      },
      embeddingDelayMs: 0,
    });
    const before = testDb
      .prepare(
        "SELECT source_id, blob_sha, embedding_status, embedding_json FROM skill_catalog_blobs ORDER BY blob_sha",
      )
      .all();

    const related = await findRelatedSkills({
      orgId: ORG_A,
      sourceId,
      snapshot: explicit,
      candidate: {
        name: "Candidate Review",
        description: 'Use token = "draft-secret-value" during review.',
        proposedPath: "projects/team/skills/candidate.md",
        replacesPath: replacedPath,
        body: [
          "# Candidate",
          "",
          "PRIVATE FULL BODY INSTRUCTIONS.",
          "",
          "## Workflow",
        ].join("\n"),
      },
    });

    expect(related).toHaveLength(5);
    expect(related.map((result) => result.path)).toEqual(paths.slice(1, 6));
    expect(related.some((result) => result.path === replacedPath)).toBe(false);
    expect(related.some((result) => result.path === "shared/skills/newer.md")).toBe(
      false,
    );
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain("candidate review");
    expect(embeddedTexts[0]).toContain("[REDACTED:Generic Secret]");
    expect(embeddedTexts[0]).toContain("Workflow");
    expect(embeddedTexts[0]).not.toContain("draft-secret-value");
    expect(embeddedTexts[0]).not.toContain("PRIVATE FULL BODY");
    const after = testDb
      .prepare(
        "SELECT source_id, blob_sha, embedding_status, embedding_json FROM skill_catalog_blobs ORDER BY blob_sha",
      )
      .all();
    expect(after).toEqual(before);
  });

  it("returns an empty advisory result without embedding at entries_ready and on embedding errors", async () => {
    const sourceId = "source-related-unavailable";
    seedSource(ORG_A, sourceId);
    const entriesReady = seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId: "snapshot-related-entries",
      commitChar: "c",
      state: "entries_ready",
    });
    const searchReady = seedSnapshot({
      orgId: ORG_A,
      sourceId,
      snapshotId: "snapshot-related-search",
      commitChar: "d",
      state: "search_ready",
    });
    seedBlob({
      orgId: ORG_A,
      sourceId,
      snapshotId: searchReady.snapshotId,
      blobSha: "e".repeat(40),
      path: "shared/skills/existing.md",
      namespace: "shared",
      name: "existing",
      redactedText: "existing",
      embedding: [1, 0],
    });
    const embed = vi.fn().mockRejectedValue(new Error("Bedrock down"));
    setSkillCatalogSearchDependenciesForTests({
      generateEmbedding: embed,
      embeddingDelayMs: 0,
    });
    const candidate = {
      name: "Candidate",
      proposedPath: "shared/skills/candidate.md",
      body: "# Candidate",
    };

    await expect(
      findRelatedSkills({
        orgId: ORG_A,
        sourceId,
        snapshot: entriesReady,
        candidate,
      }),
    ).resolves.toEqual([]);
    expect(embed).not.toHaveBeenCalled();

    await expect(
      findRelatedSkills({
        orgId: ORG_A,
        sourceId,
        snapshot: searchReady,
        candidate,
      }),
    ).resolves.toEqual([]);
    expect(embed).toHaveBeenCalledOnce();

    await expect(
      findRelatedSkills({
        orgId: ORG_B,
        sourceId,
        snapshot: searchReady,
        candidate,
      }),
    ).resolves.toEqual([]);
  });
});
