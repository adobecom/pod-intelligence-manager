import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

import {
  SKILL_MATCHER_VERSION,
  hashNormalizedSkillContent,
} from "@pim/shared/skill-catalog";
import { createTables } from "../../db/schema.js";
import {
  configureSkillCatalogWebhookSecret,
  createSkillCatalogSource,
  ensureExactSkillCatalogSnapshot,
  getSkillCatalogPage,
  getSkillCatalogSourceStatus,
  listSkillCatalogSources,
  resetSkillCatalogBuildsForTests,
  resolveSkillCatalogWebhookSecret,
  setSkillCatalogGitClientFactoryForTests,
  SkillCatalogError,
  syncSkillCatalogSource,
  waitForSkillCatalogSnapshotBuild,
} from "../skill-catalog.js";
import {
  resetSkillCatalogFreshnessForTests,
  runSkillCatalogRefPollTick,
} from "../skill-catalog-freshness.js";
import { setSkillCatalogMetricSink } from "../skill-catalog-metrics.js";
import {
  reconcileSkillCatalogSearchReadySnapshots,
  resetSkillCatalogSearchForTests,
  setSkillCatalogSearchDependenciesForTests,
} from "../skill-catalog-search.js";
import {
  SKILL_RELATED_LOOKUP_BUDGET_MS,
  validateSkillConflicts,
} from "../skill-conflicts.js";
import type {
  ResolvedGitCommit,
  SkillCatalogGitClient,
  SkillCatalogTreeEntry,
} from "../skill-catalog-github.js";

const ORG_A = "org-skill-a";
const ORG_B = "org-skill-b";
const COMMIT_A = "a".repeat(40);
const TREE_A = "1".repeat(40);
const COMMIT_B = "b".repeat(40);
const TREE_B = "2".repeat(40);
const BLOB_REVIEW = "c".repeat(40);
const BLOB_SHARED = "d".repeat(40);
const BLOB_NEW = "e".repeat(40);

const REVIEW_BODY = [
  "---",
  "name: 'Review PR'",
  'description: \'Use token = "super-secret-value" before every review.\'',
  "---",
  "# Review fallback",
  "",
  "Review pull requests.",
].join("\n");

class FakeGitClient implements SkillCatalogGitClient {
  commits = new Map<string, ResolvedGitCommit>();
  trees = new Map<string, SkillCatalogTreeEntry[]>();
  blobs = new Map<string, string>();
  resolveCalls: string[] = [];
  treeCalls: string[] = [];
  blobCalls: string[] = [];
  resolveOverride?: (ref: string) => Promise<ResolvedGitCommit>;

  async resolveCommit(ref: string): Promise<ResolvedGitCommit> {
    this.resolveCalls.push(ref);
    if (this.resolveOverride) return this.resolveOverride(ref);
    const resolved = this.commits.get(ref);
    if (!resolved) throw new Error(`missing commit ${ref}`);
    return resolved;
  }

  async getRecursiveTree(treeSha: string): Promise<SkillCatalogTreeEntry[]> {
    this.treeCalls.push(treeSha);
    const tree = this.trees.get(treeSha);
    if (!tree) throw new Error(`missing tree ${treeSha}`);
    return tree;
  }

  async getBlob(blobSha: string): Promise<string> {
    this.blobCalls.push(blobSha);
    const blob = this.blobs.get(blobSha);
    if (blob === undefined) throw new Error(`missing blob ${blobSha}`);
    return blob;
  }
}

let sourceSeq = 0;

function seedOrg(orgId: string): void {
  const userId = `user-${orgId}`;
  const now = new Date().toISOString();
  testDb
    .prepare("INSERT INTO users (user_id, email, created_at) VALUES (?, ?, ?)")
    .run(userId, `${userId}@example.com`, now);
  testDb
    .prepare(
      "INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(orgId, orgId, orgId, userId, now);
}

function createSource(orgId = ORG_A) {
  sourceSeq += 1;
  return createSkillCatalogSource(orgId, {
    sourceId: `skill-source-${sourceSeq}`,
    displayName: `Skills ${sourceSeq}`,
    owner: "Adobe-acom",
    repo: `mimir-${sourceSeq}`,
    defaultRef: "main",
    credentialAlias: "TEST_SKILL_GITHUB_TOKEN",
    layoutRules: [
      { glob: "projects/*/skills/**/*.md", namespace: "project:{1}" },
      { glob: "shared/skills/**/*.md", namespace: "shared" },
    ],
    excludeGlobs: ["projects/*/skills/**/context-*.md"],
  });
}

function configureInitialRepo(fake: FakeGitClient): void {
  fake.commits.set("main", { commitSha: COMMIT_A, treeSha: TREE_A });
  fake.commits.set(COMMIT_A, { commitSha: COMMIT_A, treeSha: TREE_A });
  fake.trees.set(TREE_A, [
    {
      path: "projects/alpha/skills/review.md",
      type: "blob",
      sha: BLOB_REVIEW,
      size: Buffer.byteLength(REVIEW_BODY),
    },
    {
      path: "projects/alpha/skills/internal/context-review.md",
      type: "blob",
      sha: "f".repeat(40),
      size: 20,
    },
    {
      path: "shared/skills/release-audit.md",
      type: "blob",
      sha: BLOB_SHARED,
      size: 80,
    },
    {
      path: "README.md",
      type: "blob",
      sha: "0".repeat(40),
      size: 10,
    },
  ]);
  fake.blobs.set(BLOB_REVIEW, REVIEW_BODY);
  fake.blobs.set(
    BLOB_SHARED,
    "# Release Audit\n\nChecks every release before publication.",
  );
}

beforeAll(() => {
  createTables();
  seedOrg(ORG_A);
  seedOrg(ORG_B);
});

afterEach(() => {
  resetSkillCatalogBuildsForTests();
  resetSkillCatalogFreshnessForTests();
  resetSkillCatalogSearchForTests();
  setSkillCatalogMetricSink(null);
  delete process.env.TEST_SKILL_WEBHOOK_SECRET;
  testDb.prepare("DELETE FROM skill_catalog_sources").run();
});

afterAll(() => {
  testDb.close();
});

describe("skill catalog webhook source configuration", () => {
  it("configures and rotates an existing source through an environment alias", () => {
    const source = createSource();
    process.env.TEST_SKILL_WEBHOOK_SECRET = "first-webhook-secret";

    const configured = configureSkillCatalogWebhookSecret(
      ORG_A,
      source.sourceId,
      "TEST_SKILL_WEBHOOK_SECRET",
    );
    expect(configured.webhookSecretAlias).toBe("TEST_SKILL_WEBHOOK_SECRET");

    const stored = testDb
      .prepare(
        `SELECT webhook_secret_alias, webhook_secret_hash
         FROM skill_catalog_sources
         WHERE source_id = ?`,
      )
      .get(source.sourceId) as {
      webhook_secret_alias: string;
      webhook_secret_hash: string;
    };
    expect(stored.webhook_secret_hash).toBe(
      createHash("sha256").update("first-webhook-secret").digest("hex"),
    );
    expect(resolveSkillCatalogWebhookSecret(source.sourceId)).toMatchObject({
      status: "ready",
      orgId: ORG_A,
      secret: "first-webhook-secret",
    });

    process.env.TEST_SKILL_WEBHOOK_SECRET = "rotated-before-reconfigure";
    expect(resolveSkillCatalogWebhookSecret(source.sourceId)).toEqual({
      status: "fingerprint_mismatch",
    });
    configureSkillCatalogWebhookSecret(
      ORG_A,
      source.sourceId,
      "TEST_SKILL_WEBHOOK_SECRET",
    );
    expect(resolveSkillCatalogWebhookSecret(source.sourceId)).toMatchObject({
      status: "ready",
      secret: "rotated-before-reconfigure",
    });

    configureSkillCatalogWebhookSecret(ORG_A, source.sourceId, null);
    expect(resolveSkillCatalogWebhookSecret(source.sourceId)).toEqual({
      status: "not_configured",
    });
  });
});

describe("skill catalog snapshots", () => {
  it("syncs a browsable, redacted, org-isolated catalog", async () => {
    const source = createSource();
    const fake = new FakeGitClient();
    configureInitialRepo(fake);
    setSkillCatalogGitClientFactoryForTests(() => fake);

    const result = await syncSkillCatalogSource(ORG_A, source.sourceId);

    expect(result.state).toBe("entries_ready");
    expect(fake.treeCalls).toEqual([TREE_A]);
    expect(fake.blobCalls.sort()).toEqual([BLOB_REVIEW, BLOB_SHARED].sort());

    const page = getSkillCatalogPage({
      orgId: ORG_A,
      sourceId: source.sourceId,
      limit: 100,
    });
    expect(page.catalog).toMatchObject({
      commitSha: COMMIT_A,
      snapshotState: "entries_ready",
    });
    expect(page.entries).toEqual([
      expect.objectContaining({
        name: "review-pr",
        namespace: "project:alpha",
        path: "projects/alpha/skills/review.md",
      }),
      expect.objectContaining({
        name: "release-audit",
        namespace: "shared",
        path: "shared/skills/release-audit.md",
      }),
    ]);
    expect(page.entries[0].description).toContain("[REDACTED:Generic Secret]");
    expect(page.entries.some((entry) => entry.path.includes("context-review"))).toBe(
      false,
    );

    const blob = testDb
      .prepare(
        `SELECT content_hash, description, redacted_text, embedding_json,
                embedding_status
         FROM skill_catalog_blobs
         WHERE source_id = ? AND blob_sha = ?`,
      )
      .get(source.sourceId, BLOB_REVIEW) as {
      content_hash: string;
      description: string;
      redacted_text: string;
      embedding_json: string | null;
      embedding_status: string;
    };
    expect(blob.content_hash).toBe(hashNormalizedSkillContent(REVIEW_BODY));
    expect(blob.description).not.toContain("super-secret-value");
    expect(blob.redacted_text).toContain("review pr");
    expect(blob.redacted_text).not.toContain("super-secret-value");
    expect(blob.embedding_json).toBeNull();
    expect(blob.embedding_status).toBe("pending");

    const status = getSkillCatalogSourceStatus(ORG_A, source.sourceId);
    expect(status.latestEntriesReadyCommitSha).toBe(COMMIT_A);
    expect(status.latestSearchReadyCommitSha).toBeNull();

    const firstPage = getSkillCatalogPage({
      orgId: ORG_A,
      sourceId: source.sourceId,
      limit: 1,
    });
    const secondPage = getSkillCatalogPage({
      orgId: ORG_A,
      sourceId: source.sourceId,
      afterPath: firstPage.nextPath!,
      limit: 1,
    });
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.nextPath).toBe(firstPage.entries[0].path);
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.entries[0].path).not.toBe(firstPage.entries[0].path);
    expect(secondPage.nextPath).toBeNull();

    expect(listSkillCatalogSources(ORG_B)).toEqual([]);
    expect(() =>
      getSkillCatalogPage({
        orgId: ORG_B,
        sourceId: source.sourceId,
        limit: 100,
      }),
    ).toThrow(SkillCatalogError);
  });

  it("reuses content-addressed blobs across snapshots", async () => {
    const source = createSource();
    const fake = new FakeGitClient();
    configureInitialRepo(fake);
    setSkillCatalogGitClientFactoryForTests(() => fake);
    await syncSkillCatalogSource(ORG_A, source.sourceId);

    fake.commits.set("main", { commitSha: COMMIT_B, treeSha: TREE_B });
    fake.commits.set(COMMIT_B, { commitSha: COMMIT_B, treeSha: TREE_B });
    fake.trees.set(TREE_B, [
      {
        path: "projects/alpha/skills/review.md",
        type: "blob",
        sha: BLOB_REVIEW,
        size: Buffer.byteLength(REVIEW_BODY),
      },
      {
        path: "projects/beta/skills/new.md",
        type: "blob",
        sha: BLOB_NEW,
        size: 30,
      },
    ]);
    fake.blobs.set(BLOB_NEW, "# New Skill\n\nDoes something new.");

    await syncSkillCatalogSource(ORG_A, source.sourceId);

    expect(fake.blobCalls.filter((sha) => sha === BLOB_REVIEW)).toHaveLength(1);
    expect(fake.blobCalls.filter((sha) => sha === BLOB_NEW)).toHaveLength(1);
    const blobCount = testDb
      .prepare(
        "SELECT COUNT(*) AS count FROM skill_catalog_blobs WHERE source_id = ?",
      )
      .get(source.sourceId) as { count: number };
    expect(blobCount.count).toBe(3);
  });

  it("bounds snapshot history and removes blobs no retained snapshot uses", async () => {
    const source = createSource();
    const fake = new FakeGitClient();
    configureInitialRepo(fake);
    setSkillCatalogGitClientFactoryForTests(() => fake);
    await syncSkillCatalogSource(ORG_A, source.sourceId);

    const insertBlob = testDb.prepare(
      `INSERT INTO skill_catalog_blobs
         (org_id, source_id, blob_sha, normalized_name, description, content_hash,
          redacted_text, embedding_json, embedding_status, matcher_version, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, 'pending', ?, ?)`,
    );
    const insertSnapshot = testDb.prepare(
      `INSERT INTO skill_catalog_snapshots
         (snapshot_id, org_id, source_id, commit_sha, state, is_default_ref, created_at)
       VALUES (?, ?, ?, ?, 'entries_ready', 0, ?)`,
    );
    const insertEntry = testDb.prepare(
      `INSERT INTO skill_catalog_entries
         (snapshot_id, path, blob_sha, namespace)
       VALUES (?, ?, ?, 'shared')`,
    );
    const historicalBlobShas: string[] = [];
    for (let index = 0; index < 52; index += 1) {
      const snapshotId = `snapshot-history-${index}`;
      const commitSha = (index + 1).toString(16).padStart(40, "0");
      const blobSha = (index + 1_000).toString(16).padStart(40, "0");
      const createdAt = new Date(
        Date.UTC(2026, 0, 1) + index * 1_000,
      ).toISOString();
      historicalBlobShas.push(blobSha);
      insertBlob.run(
        ORG_A,
        source.sourceId,
        blobSha,
        `history-${index}`,
        `hash-${index}`,
        `history ${index}`,
        SKILL_MATCHER_VERSION,
        createdAt,
      );
      insertSnapshot.run(
        snapshotId,
        ORG_A,
        source.sourceId,
        commitSha,
        createdAt,
      );
      insertEntry.run(
        snapshotId,
        `shared/skills/history-${index}.md`,
        blobSha,
      );
    }
    // A process restart can leave a row marked building with no live build.
    testDb
      .prepare(
        "UPDATE skill_catalog_snapshots SET state = 'building' WHERE snapshot_id = ?",
      )
      .run("snapshot-history-0");
    const orphanBlobSha = "9".repeat(40);
    insertBlob.run(
      ORG_A,
      source.sourceId,
      orphanBlobSha,
      "orphan",
      "orphan-hash",
      "orphan",
      SKILL_MATCHER_VERSION,
      new Date().toISOString(),
    );

    // An ordinary default-ref reconciliation also cleans up history that
    // predates rollout of the retention policy.
    await syncSkillCatalogSource(ORG_A, source.sourceId);

    const retained = testDb
      .prepare(
        `SELECT snapshot_id, is_default_ref
         FROM skill_catalog_snapshots
         WHERE source_id = ?
         ORDER BY snapshot_id`,
      )
      .all(source.sourceId) as unknown as Array<{
      snapshot_id: string;
      is_default_ref: number;
    }>;
    expect(retained).toHaveLength(51);
    expect(retained.filter((row) => row.is_default_ref === 1)).toHaveLength(1);
    expect(retained.some((row) => row.snapshot_id === "snapshot-history-0")).toBe(
      false,
    );
    expect(retained.some((row) => row.snapshot_id === "snapshot-history-1")).toBe(
      false,
    );
    expect(retained.some((row) => row.snapshot_id === "snapshot-history-2")).toBe(
      true,
    );

    const evictedEntry = testDb
      .prepare(
        "SELECT 1 FROM skill_catalog_entries WHERE snapshot_id = ? LIMIT 1",
      )
      .get("snapshot-history-0");
    expect(evictedEntry).toBeUndefined();
    const retainedBlobs = testDb
      .prepare(
        `SELECT blob_sha
         FROM skill_catalog_blobs
         WHERE source_id = ?`,
      )
      .all(source.sourceId) as unknown as Array<{ blob_sha: string }>;
    const retainedBlobShas = new Set(
      retainedBlobs.map((row) => row.blob_sha),
    );
    expect(retainedBlobShas.has(historicalBlobShas[0])).toBe(false);
    expect(retainedBlobShas.has(historicalBlobShas[1])).toBe(false);
    expect(retainedBlobShas.has(orphanBlobSha)).toBe(false);
    expect(retainedBlobShas.has(historicalBlobShas[2])).toBe(true);
    expect(retainedBlobShas.has(BLOB_REVIEW)).toBe(true);
  });

  it("defers orphan blob cleanup while another snapshot build is in flight", async () => {
    const source = createSource();
    const fake = new FakeGitClient();
    configureInitialRepo(fake);
    fake.trees.set(TREE_B, []);
    setSkillCatalogGitClientFactoryForTests(() => fake);
    await syncSkillCatalogSource(ORG_A, source.sourceId);

    const orphanBlobSha = "8".repeat(40);
    testDb
      .prepare(
        `INSERT INTO skill_catalog_blobs
           (org_id, source_id, blob_sha, normalized_name, description, content_hash,
            redacted_text, embedding_json, embedding_status, matcher_version, created_at)
         VALUES (?, ?, ?, 'orphan', NULL, 'orphan-hash', 'orphan', NULL,
                 'pending', ?, ?)`,
      )
      .run(
        ORG_A,
        source.sourceId,
        orphanBlobSha,
        SKILL_MATCHER_VERSION,
        new Date().toISOString(),
      );

    let release!: (value: ResolvedGitCommit) => void;
    const gate = new Promise<ResolvedGitCommit>((resolve) => {
      release = resolve;
    });
    fake.resolveOverride = async (ref) => {
      if (ref === COMMIT_B) return gate;
      if (ref === "main") return { commitSha: COMMIT_A, treeSha: TREE_A };
      throw new Error(`unexpected ref ${ref}`);
    };

    expect(
      ensureExactSkillCatalogSnapshot(ORG_A, source.sourceId, COMMIT_B),
    ).toMatchObject({ status: "building" });
    const pending = waitForSkillCatalogSnapshotBuild(source.sourceId, COMMIT_B);

    await syncSkillCatalogSource(ORG_A, source.sourceId);
    expect(
      testDb
        .prepare(
          `SELECT 1
           FROM skill_catalog_blobs
           WHERE source_id = ? AND blob_sha = ?`,
        )
        .get(source.sourceId, orphanBlobSha),
    ).toBeDefined();

    release({ commitSha: COMMIT_B, treeSha: TREE_B });
    await expect(pending).resolves.toMatchObject({ state: "search_ready" });
    expect(
      testDb
        .prepare(
          `SELECT 1
           FROM skill_catalog_blobs
           WHERE source_id = ? AND blob_sha = ?`,
        )
        .get(source.sourceId, orphanBlobSha),
    ).toBeUndefined();
  });

  it("polling reconciles a default-ref advance missed by the webhook", async () => {
    const source = createSource();
    const fake = new FakeGitClient();
    configureInitialRepo(fake);
    setSkillCatalogGitClientFactoryForTests(() => fake);
    await syncSkillCatalogSource(ORG_A, source.sourceId);

    fake.commits.set("main", { commitSha: COMMIT_B, treeSha: TREE_B });
    fake.trees.set(TREE_B, []);
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    await expect(runSkillCatalogRefPollTick(log)).resolves.toEqual({
      failures: 0,
      sourceCount: 1,
    });
    expect(getSkillCatalogSourceStatus(ORG_A, source.sourceId)).toMatchObject({
      latestEntriesReadyCommitSha: COMMIT_B,
      syncStatus: "ready",
    });
  });

  it("makes a reverted default-ref SHA the sole apparent latest snapshot", async () => {
    const source = createSource();
    const fake = new FakeGitClient();
    configureInitialRepo(fake);
    fake.commits.set(COMMIT_B, { commitSha: COMMIT_B, treeSha: TREE_B });
    fake.trees.set(TREE_B, []);
    setSkillCatalogGitClientFactoryForTests(() => fake);

    await syncSkillCatalogSource(ORG_A, source.sourceId);
    fake.commits.set("main", { commitSha: COMMIT_B, treeSha: TREE_B });
    await syncSkillCatalogSource(ORG_A, source.sourceId);
    expect(getSkillCatalogSourceStatus(ORG_A, source.sourceId)).toMatchObject({
      latestEntriesReadyCommitSha: COMMIT_B,
    });

    // Simulate a force-push/revert back to an older, already-built commit.
    fake.commits.set("main", { commitSha: COMMIT_A, treeSha: TREE_A });
    const reverted = await syncSkillCatalogSource(ORG_A, source.sourceId);
    expect(reverted.snapshot).toMatchObject({
      commitSha: COMMIT_A,
      isDefaultRef: true,
    });
    expect(getSkillCatalogSourceStatus(ORG_A, source.sourceId)).toMatchObject({
      latestEntriesReadyCommitSha: COMMIT_A,
    });
    const current = testDb
      .prepare(
        `SELECT commit_sha
         FROM skill_catalog_snapshots
         WHERE source_id = ? AND is_default_ref = 1`,
      )
      .all(source.sourceId) as unknown as Array<{ commit_sha: string }>;
    expect(current).toEqual([{ commit_sha: COMMIT_A }]);
  });

  it("does not let a later historical-SHA build replace the default-ref catalog", async () => {
    const source = createSource();
    const fake = new FakeGitClient();
    configureInitialRepo(fake);
    fake.commits.set(COMMIT_B, { commitSha: COMMIT_B, treeSha: TREE_B });
    fake.trees.set(TREE_B, []);
    setSkillCatalogGitClientFactoryForTests(() => fake);

    const defaultSnapshot = await syncSkillCatalogSource(ORG_A, source.sourceId);
    expect(defaultSnapshot.snapshot.isDefaultRef).toBe(true);

    expect(
      ensureExactSkillCatalogSnapshot(ORG_A, source.sourceId, COMMIT_B),
    ).toMatchObject({ status: "building" });
    await expect(
      waitForSkillCatalogSnapshotBuild(source.sourceId, COMMIT_B),
    ).resolves.toMatchObject({
      state: "search_ready",
      snapshot: { isDefaultRef: false },
    });

    expect(getSkillCatalogSourceStatus(ORG_A, source.sourceId)).toMatchObject({
      latestEntriesReadyCommitSha: COMMIT_A,
    });
    expect(
      getSkillCatalogPage({
        orgId: ORG_A,
        sourceId: source.sourceId,
        limit: 100,
      }).catalog.commitSha,
    ).toBe(COMMIT_A);
  });

  it("single-flights concurrent exact-SHA builds", async () => {
    const source = createSource();
    const fake = new FakeGitClient();
    fake.trees.set(TREE_A, []);
    let release!: (value: ResolvedGitCommit) => void;
    const gate = new Promise<ResolvedGitCommit>((resolve) => {
      release = resolve;
    });
    fake.resolveOverride = async () => gate;
    setSkillCatalogGitClientFactoryForTests(() => fake);

    const outcomes = Array.from({ length: 10 }, () =>
      ensureExactSkillCatalogSnapshot(ORG_A, source.sourceId, COMMIT_A),
    );
    expect(outcomes.every((outcome) => outcome.status === "building")).toBe(true);
    expect(fake.resolveCalls).toHaveLength(1);

    const pending = waitForSkillCatalogSnapshotBuild(source.sourceId, COMMIT_A);
    release({ commitSha: COMMIT_A, treeSha: TREE_A });
    await expect(pending).resolves.toMatchObject({ state: "search_ready" });
    expect(fake.resolveCalls).toHaveLength(1);
    expect(fake.treeCalls).toEqual([TREE_A]);
  });

  it("promotes an exact-SHA build when a default-ref sync joins its flight", async () => {
    const source = createSource();
    const fake = new FakeGitClient();
    fake.trees.set(TREE_A, []);
    let releaseExact!: (value: ResolvedGitCommit) => void;
    const exactGate = new Promise<ResolvedGitCommit>((resolve) => {
      releaseExact = resolve;
    });
    fake.resolveOverride = async (ref) => {
      if (ref === COMMIT_A) return exactGate;
      if (ref === "main") {
        return { commitSha: COMMIT_A, treeSha: TREE_A };
      }
      throw new Error(`unexpected ref ${ref}`);
    };
    setSkillCatalogGitClientFactoryForTests(() => fake);

    expect(
      ensureExactSkillCatalogSnapshot(ORG_A, source.sourceId, COMMIT_A),
    ).toMatchObject({ status: "building" });
    const exactBuild = waitForSkillCatalogSnapshotBuild(
      source.sourceId,
      COMMIT_A,
    );
    const defaultSync = syncSkillCatalogSource(ORG_A, source.sourceId);
    await vi.waitFor(() => {
      expect(fake.resolveCalls).toContain("main");
    });

    releaseExact({ commitSha: COMMIT_A, treeSha: TREE_A });
    await expect(exactBuild).resolves.toMatchObject({
      state: "search_ready",
    });
    await expect(defaultSync).resolves.toMatchObject({
      state: "search_ready",
      snapshot: {
        commitSha: COMMIT_A,
        isDefaultRef: true,
      },
    });
    expect(getSkillCatalogSourceStatus(ORG_A, source.sourceId)).toMatchObject({
      latestEntriesReadyCommitSha: COMMIT_A,
      syncStatus: "ready",
    });
    expect(fake.treeCalls).toEqual([TREE_A]);
  });

  it("retries a failed exact-SHA build on the next request", async () => {
    const metrics = vi.fn();
    setSkillCatalogMetricSink(metrics);
    const source = createSource();
    const fake = new FakeGitClient();
    fake.trees.set(TREE_A, []);
    let attempt = 0;
    fake.resolveOverride = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary GitHub failure");
      return { commitSha: COMMIT_A, treeSha: TREE_A };
    };
    setSkillCatalogGitClientFactoryForTests(() => fake);

    expect(
      ensureExactSkillCatalogSnapshot(ORG_A, source.sourceId, COMMIT_A),
    ).toMatchObject({ status: "building" });
    const pending = waitForSkillCatalogSnapshotBuild(source.sourceId, COMMIT_A);
    await expect(pending).resolves.toMatchObject({
      state: "failed",
      error: "temporary GitHub failure",
    });

    const retries = Array.from({ length: 5 }, () =>
      ensureExactSkillCatalogSnapshot(ORG_A, source.sourceId, COMMIT_A),
    );
    expect(retries.every((retry) => retry.status === "building")).toBe(true);
    expect(fake.resolveCalls).toHaveLength(2);
    await expect(
      waitForSkillCatalogSnapshotBuild(source.sourceId, COMMIT_A),
    ).resolves.toMatchObject({ state: "search_ready" });
    expect(
      ensureExactSkillCatalogSnapshot(ORG_A, source.sourceId, COMMIT_A),
    ).toMatchObject({ status: "ready" });
    expect(fake.resolveCalls).toHaveLength(2);
    expect(
      metrics.mock.calls.map(([metric]) => ({
        name: metric.name,
        state: metric.dimensions?.State,
        value: metric.value,
      })),
    ).toEqual(
      expect.arrayContaining([
        { name: "SingleFlightQueueDepth", state: undefined, value: 1 },
        { name: "SnapshotBuildLatency", state: "failed", value: expect.any(Number) },
        { name: "ExactShaBuildFailures", state: undefined, value: 1 },
        { name: "SingleFlightQueueDepth", state: undefined, value: 0 },
      ]),
    );
  });
});

describe("deterministic skill conflicts", () => {
  async function readyCatalog() {
    const source = createSource();
    const fake = new FakeGitClient();
    configureInitialRepo(fake);
    setSkillCatalogGitClientFactoryForTests(() => fake);
    await syncSkillCatalogSource(ORG_A, source.sourceId);
    return source;
  }

  function makeCatalogSearchReady(sourceId: string): void {
    testDb
      .prepare(
        `UPDATE skill_catalog_blobs
         SET embedding_status = 'ready',
             embedding_json = CASE
               WHEN blob_sha = ? THEN '[1,0]'
               ELSE '[0,1]'
             END
         WHERE source_id = ? AND org_id = ?`,
      )
      .run(BLOB_REVIEW, sourceId, ORG_A);
    expect(reconcileSkillCatalogSearchReadySnapshots().searchReady).toBe(1);
  }

  it("returns clean and conflicting candidates independently in one batch", async () => {
    const source = await readyCatalog();
    const outcome = await validateSkillConflicts({
      orgId: ORG_A,
      sourceId: source.sourceId,
      baseCommitSha: COMMIT_A,
      candidates: [
        {
          candidateId: "path",
          name: "Different",
          proposedPath: "projects/alpha/skills/review.md",
          targetNamespace: "project:alpha",
          body: "# Different\n\nDifferent behavior.",
        },
        {
          candidateId: "name",
          name: "Review_PR.md",
          proposedPath: "projects/alpha/skills/review-copy.md",
          targetNamespace: "project:alpha",
          body: "# Different body",
        },
        {
          candidateId: "content",
          name: "Copied Review",
          proposedPath: "projects/greenfield/skills/copied.md",
          targetNamespace: "project:greenfield",
          body: REVIEW_BODY,
        },
        {
          candidateId: "clean",
          name: "Brand New",
          proposedPath: "projects/greenfield/skills/brand-new.md",
          targetNamespace: "project:greenfield",
          body: "# Brand New\n\nUnique behavior.",
        },
      ],
    });

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("expected ready outcome");
    const byId = Object.fromEntries(
      outcome.response.results.map((result) => [result.candidateId, result]),
    );
    expect(byId.path.conflicts.map((conflict) => conflict.kind)).toContain(
      "exact_path",
    );
    expect(byId.name.conflicts.map((conflict) => conflict.kind)).toContain(
      "same_namespace_name",
    );
    expect(byId.content.conflicts.map((conflict) => conflict.kind)).toContain(
      "exact_content",
    );
    expect(byId.clean).toEqual({
      candidateId: "clean",
      status: "clear",
      conflicts: [],
      related: [],
    });
    expect(JSON.stringify(outcome.response)).not.toMatch(
      /disposition|allowedAction|decision/i,
    );
  });

  it("rebuilds a stale matcher snapshot before returning a verdict", async () => {
    const source = await readyCatalog();
    testDb
      .prepare(
        `UPDATE skill_catalog_blobs
         SET matcher_version = 'legacy',
             normalized_name = 'legacy-name',
             content_hash = 'legacy-hash'
         WHERE source_id = ? AND blob_sha = ?`,
      )
      .run(source.sourceId, BLOB_REVIEW);

    const candidate = {
      candidateId: "copied",
      name: "Different Name",
      proposedPath: "projects/greenfield/skills/copied.md",
      targetNamespace: "project:greenfield" as const,
      body: REVIEW_BODY,
    };
    const initialValidation = validateSkillConflicts({
      orgId: ORG_A,
      sourceId: source.sourceId,
      baseCommitSha: COMMIT_A,
      candidates: [candidate],
    });
    const rebuild = waitForSkillCatalogSnapshotBuild(
      source.sourceId,
      COMMIT_A,
    );

    await expect(initialValidation).resolves.toMatchObject({
      status: "building",
    });
    await expect(rebuild).resolves.toMatchObject({ state: "entries_ready" });

    const outcome = await validateSkillConflicts({
      orgId: ORG_A,
      sourceId: source.sourceId,
      baseCommitSha: COMMIT_A,
      candidates: [candidate],
    });
    expect(outcome).toMatchObject({
      status: "ready",
      response: {
        matcherVersion: SKILL_MATCHER_VERSION,
        results: [
          {
            candidateId: "copied",
            status: "conflict_found",
            conflicts: [{ kind: "exact_content" }],
          },
        ],
      },
    });
    const rebuiltBlob = testDb
      .prepare(
        `SELECT matcher_version, normalized_name, content_hash
         FROM skill_catalog_blobs
         WHERE source_id = ? AND blob_sha = ?`,
      )
      .get(source.sourceId, BLOB_REVIEW) as {
      matcher_version: string;
      normalized_name: string;
      content_hash: string;
    };
    expect(rebuiltBlob).toEqual({
      matcher_version: SKILL_MATCHER_VERSION,
      normalized_name: "review-pr",
      content_hash: hashNormalizedSkillContent(REVIEW_BODY),
    });
  });

  it("adds advisory related skills only after the exact snapshot is search-ready", async () => {
    const source = await readyCatalog();
    makeCatalogSearchReady(source.sourceId);
    const generateEmbedding = vi.fn(async () => [1, 0]);
    setSkillCatalogSearchDependenciesForTests({
      embeddingAvailable: () => true,
      generateEmbedding,
      embeddingDelayMs: 0,
      sleep: async () => undefined,
      now: () => 0,
    });

    const outcome = await validateSkillConflicts({
      orgId: ORG_A,
      sourceId: source.sourceId,
      baseCommitSha: COMMIT_A,
      candidates: [
        {
          candidateId: "related",
          name: "Review Helper",
          proposedPath: "projects/greenfield/skills/review-helper.md",
          targetNamespace: "project:greenfield",
          body: "# Review Helper\n\nHelps a reviewer inspect a change.",
        },
      ],
    });

    expect(outcome).toMatchObject({
      status: "ready",
      response: {
        catalog: { snapshotState: "search_ready" },
        results: [
          {
            candidateId: "related",
            status: "clear",
            conflicts: [],
          },
        ],
      },
    });
    if (outcome.status !== "ready") throw new Error("expected ready outcome");
    expect(outcome.response.results[0]?.related).toHaveLength(2);
    expect(outcome.response.results[0]?.related[0]).toMatchObject({
      path: "projects/alpha/skills/review.md",
      blobSha: BLOB_REVIEW,
      similarity: 1,
    });
    expect(outcome.response.results[0]?.related.length).toBeLessThanOrEqual(5);
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
  });

  it("keeps deterministic validation available when related-skill embedding fails", async () => {
    const source = await readyCatalog();
    makeCatalogSearchReady(source.sourceId);
    setSkillCatalogSearchDependenciesForTests({
      embeddingAvailable: () => true,
      generateEmbedding: vi.fn(async () => {
        throw new Error("Bedrock unavailable");
      }),
      embeddingDelayMs: 0,
      sleep: async () => undefined,
      now: () => 0,
    });

    const outcome = await validateSkillConflicts({
      orgId: ORG_A,
      sourceId: source.sourceId,
      baseCommitSha: COMMIT_A,
      candidates: [
        {
          candidateId: "path",
          name: "Different",
          proposedPath: "projects/alpha/skills/review.md",
          targetNamespace: "project:alpha",
          body: "# Different\n\nDifferent behavior.",
        },
      ],
    });

    expect(outcome).toMatchObject({
      status: "ready",
      response: {
        results: [
          {
            candidateId: "path",
            status: "conflict_found",
            conflicts: [{ kind: "exact_path" }],
            related: [],
          },
        ],
      },
    });
  });

  it("returns the deterministic verdict when advisory related lookup exceeds its budget", async () => {
    const source = await readyCatalog();
    makeCatalogSearchReady(source.sourceId);
    const generateEmbedding = vi.fn(
      () => new Promise<number[]>(() => undefined),
    );
    setSkillCatalogSearchDependenciesForTests({
      embeddingAvailable: () => true,
      generateEmbedding,
      embeddingDelayMs: 0,
    });

    vi.useFakeTimers();
    try {
      const pending = validateSkillConflicts({
        orgId: ORG_A,
        sourceId: source.sourceId,
        baseCommitSha: COMMIT_A,
        candidates: [
          {
            candidateId: "path",
            name: "Different",
            proposedPath: "projects/alpha/skills/review.md",
            targetNamespace: "project:alpha",
            body: "# Different\n\nDifferent behavior.",
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(SKILL_RELATED_LOOKUP_BUDGET_MS);
      await expect(pending).resolves.toMatchObject({
        status: "ready",
        response: {
          results: [
            {
              candidateId: "path",
              status: "conflict_found",
              conflicts: [{ kind: "exact_path" }],
              related: [],
            },
          ],
        },
      });
      expect(generateEmbedding).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes a modified file's base entry when replacesPath is supplied", async () => {
    const source = await readyCatalog();
    const outcome = await validateSkillConflicts({
      orgId: ORG_A,
      sourceId: source.sourceId,
      baseCommitSha: COMMIT_A,
      candidates: [
        {
          candidateId: "modified",
          name: "Review PR",
          proposedPath: "projects/alpha/skills/review.md",
          replacesPath: "projects/alpha/skills/review.md",
          targetNamespace: "project:alpha",
          body: "# Review PR\n\nNow performs stricter checks.",
        },
      ],
    });

    expect(outcome).toMatchObject({
      status: "ready",
      response: {
        results: [{ candidateId: "modified", status: "clear", conflicts: [] }],
      },
    });
  });

  it("reports candidate-to-candidate name and content variants symmetrically", async () => {
    const source = await readyCatalog();
    const body = "# Pair\n\nSame candidate bytes.";
    const outcome = await validateSkillConflicts({
      orgId: ORG_A,
      sourceId: source.sourceId,
      baseCommitSha: COMMIT_A,
      candidates: [
        {
          candidateId: "left",
          name: "Pair Skill",
          proposedPath: "projects/greenfield/skills/left.md",
          targetNamespace: "project:greenfield",
          body,
        },
        {
          candidateId: "right",
          name: "pair_skill.md",
          proposedPath: "projects/greenfield/skills/right.md",
          targetNamespace: "project:greenfield",
          body,
        },
      ],
    });

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("expected ready outcome");
    for (const result of outcome.response.results) {
      expect(result.conflicts.map((conflict) => conflict.kind)).toEqual(
        expect.arrayContaining([
          "candidate_same_namespace_name",
          "candidate_exact_content",
        ]),
      );
    }
  });
});
