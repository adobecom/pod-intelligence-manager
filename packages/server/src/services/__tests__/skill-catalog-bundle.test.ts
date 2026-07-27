import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  hashNormalizedSkillContent,
  SKILL_MATCHER_VERSION,
} from "@pim/shared/skill-catalog";
import { createTables } from "../../db/schema.js";
import {
  exportSkillCatalogBundle,
  importSkillCatalogBundle,
} from "../skill-catalog-bundle.js";
import {
  createSkillCatalogSource,
  getLatestReadySnapshot,
} from "../skill-catalog.js";
import {
  resetSkillCatalogSearchForTests,
  searchSkillCatalog,
  setSkillCatalogSearchDependenciesForTests,
} from "../skill-catalog-search.js";
import { validateSkillConflicts } from "../skill-conflicts.js";

const ORG_ID = "org-portable-catalog";
const SOURCE_ID = "mimir-main";
const COMMIT_SHA = "a".repeat(40);
const BLOB_SHA = "b".repeat(40);
const PATH = "projects/alpha/skills/review.md";
const BODY = "# Review PR\n\nReview pull requests before merge.";

function createSource(): void {
  createSkillCatalogSource(ORG_ID, {
    sourceId: SOURCE_ID,
    displayName: "Mimir",
    owner: "Adobe-acom",
    repo: "mimir",
    defaultRef: "main",
    credentialAlias: "MIMIR_GITHUB_TOKEN",
    layoutRules: [
      {
        glob: "projects/*/skills/**/*.md",
        namespace: "project:{1}",
      },
      { glob: "shared/skills/**/*.md", namespace: "shared" },
    ],
    excludeGlobs: ["projects/*/skills/**/context-*.md"],
  });
}

function seedSnapshot(embedding: number[] | null = null): void {
  const now = "2026-07-27T12:00:00.000Z";
  testDb
    .prepare(
      `INSERT INTO skill_catalog_snapshots
         (snapshot_id, org_id, source_id, commit_sha, state, is_default_ref, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      "snapshot-local",
      ORG_ID,
      SOURCE_ID,
      COMMIT_SHA,
      embedding ? "search_ready" : "entries_ready",
      now,
    );
  testDb
    .prepare(
      `INSERT INTO skill_catalog_blobs
         (org_id, source_id, blob_sha, normalized_name, description,
          content_hash, redacted_text, embedding_json, embedding_status,
          matcher_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ORG_ID,
      SOURCE_ID,
      BLOB_SHA,
      "review-pr",
      "Review pull requests before merge.",
      hashNormalizedSkillContent(BODY),
      "review pr\nReview pull requests before merge.",
      embedding ? JSON.stringify(embedding) : null,
      embedding ? "ready" : "pending",
      SKILL_MATCHER_VERSION,
      now,
    );
  testDb
    .prepare(
      `INSERT INTO skill_catalog_entries
         (snapshot_id, path, blob_sha, namespace)
       VALUES (?, ?, ?, ?)`,
    )
    .run("snapshot-local", PATH, BLOB_SHA, "project:alpha");
  testDb
    .prepare(
      `UPDATE skill_catalog_sources
       SET sync_status = 'ready', last_synced_at = ?
       WHERE source_id = ?`,
    )
    .run(now, SOURCE_ID);
}

beforeAll(() => {
  createTables();
  const now = new Date().toISOString();
  testDb
    .prepare("INSERT INTO users (user_id, email, created_at) VALUES (?, ?, ?)")
    .run("user-portable", "portable@example.com", now);
  testDb
    .prepare(
      `INSERT INTO orgs
         (org_id, slug, name, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(ORG_ID, ORG_ID, "Portable", "user-portable", now);
});

beforeEach(() => {
  resetSkillCatalogSearchForTests();
  testDb.prepare("DELETE FROM skill_catalog_sources").run();
  createSource();
});

describe("portable skill catalog bundles", () => {
  it("round-trips a deterministic index and serves exact conflict checks without Git access", async () => {
    seedSnapshot();
    const bundle = exportSkillCatalogBundle({
      orgId: ORG_ID,
      sourceId: SOURCE_ID,
    });
    expect(bundle).toMatchObject({
      schemaVersion: "pim.skill-catalog-bundle.v1",
      source: {
        sourceId: SOURCE_ID,
        owner: "Adobe-acom",
        repo: "mimir",
      },
      snapshot: {
        commitSha: COMMIT_SHA,
        state: "entries_ready",
        entryCount: 1,
        blobCount: 1,
        embeddingDimensions: null,
      },
    });
    expect(JSON.stringify(bundle)).not.toContain(BODY);

    testDb.prepare("DELETE FROM skill_catalog_snapshots").run();
    testDb.prepare("DELETE FROM skill_catalog_blobs").run();
    const imported = importSkillCatalogBundle({
      orgId: ORG_ID,
      sourceId: SOURCE_ID,
      bundle,
    });
    expect(imported).toEqual({
      sourceId: SOURCE_ID,
      commitSha: COMMIT_SHA,
      snapshotState: "entries_ready",
      entriesImported: 1,
      blobsImported: 1,
      embeddingDimensions: null,
    });
    expect(getLatestReadySnapshot(ORG_ID, SOURCE_ID)).toMatchObject({
      commitSha: COMMIT_SHA,
      state: "entries_ready",
      isDefaultRef: true,
    });

    const outcome = await validateSkillConflicts({
      orgId: ORG_ID,
      sourceId: SOURCE_ID,
      baseCommitSha: COMMIT_SHA,
      candidates: [
        {
          candidateId: "duplicate",
          name: "Different",
          proposedPath: PATH,
          targetNamespace: "project:alpha",
          body: "# Different\n\nDifferent behavior.",
        },
      ],
    });
    expect(outcome).toMatchObject({
      status: "ready",
      response: {
        catalog: { commitSha: COMMIT_SHA },
        results: [
          {
            candidateId: "duplicate",
            status: "conflict_found",
            conflicts: [{ kind: "exact_path" }],
          },
        ],
      },
    });
  });

  it("preserves search-ready embeddings and makes imported semantic search usable", async () => {
    const embedding = Array.from({ length: 512 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    seedSnapshot(embedding);
    const bundle = exportSkillCatalogBundle({
      orgId: ORG_ID,
      sourceId: SOURCE_ID,
    });
    expect(bundle.snapshot).toMatchObject({
      state: "search_ready",
      embeddingDimensions: 512,
    });

    testDb.prepare("DELETE FROM skill_catalog_snapshots").run();
    testDb.prepare("DELETE FROM skill_catalog_blobs").run();
    importSkillCatalogBundle({
      orgId: ORG_ID,
      sourceId: SOURCE_ID,
      bundle,
    });

    setSkillCatalogSearchDependenciesForTests({
      embeddingAvailable: () => true,
      generateEmbedding: vi.fn(async () => embedding),
      embeddingDelayMs: 0,
      sleep: async () => undefined,
      now: () => 0,
    });
    await expect(
      searchSkillCatalog({
        orgId: ORG_ID,
        sourceId: SOURCE_ID,
        query: "review a pull request",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      catalog: {
        commitSha: COMMIT_SHA,
        snapshotState: "search_ready",
      },
      results: [{ path: PATH, similarity: 1 }],
    });
  });

  it("rejects a transport-tampered bundle before writing a snapshot", () => {
    seedSnapshot();
    const bundle = exportSkillCatalogBundle({
      orgId: ORG_ID,
      sourceId: SOURCE_ID,
    });
    testDb.prepare("DELETE FROM skill_catalog_snapshots").run();
    testDb.prepare("DELETE FROM skill_catalog_blobs").run();
    bundle.entries[0].path = "projects/alpha/skills/tampered.md";

    expect(() =>
      importSkillCatalogBundle({
        orgId: ORG_ID,
        sourceId: SOURCE_ID,
        bundle,
      }),
    ).toThrow("integrity check failed");
    expect(
      (
        testDb
          .prepare(
            "SELECT COUNT(*) AS count FROM skill_catalog_snapshots WHERE source_id = ?",
          )
          .get(SOURCE_ID) as { count: number }
      ).count,
    ).toBe(0);
  });

  it("rejects a valid bundle when the configured repository identity no longer matches", () => {
    seedSnapshot();
    const bundle = exportSkillCatalogBundle({
      orgId: ORG_ID,
      sourceId: SOURCE_ID,
    });
    testDb
      .prepare(
        "UPDATE skill_catalog_sources SET repo = 'different-repo' WHERE source_id = ?",
      )
      .run(SOURCE_ID);

    expect(() =>
      importSkillCatalogBundle({
        orgId: ORG_ID,
        sourceId: SOURCE_ID,
        bundle,
      }),
    ).toThrow("repository identity or layout");
  });

  it("imports into a disabled offline source without enabling hosted polling", () => {
    seedSnapshot();
    const bundle = exportSkillCatalogBundle({
      orgId: ORG_ID,
      sourceId: SOURCE_ID,
    });
    testDb.prepare("DELETE FROM skill_catalog_snapshots").run();
    testDb.prepare("DELETE FROM skill_catalog_blobs").run();
    testDb
      .prepare(
        "UPDATE skill_catalog_sources SET enabled = 0 WHERE source_id = ?",
      )
      .run(SOURCE_ID);

    expect(
      importSkillCatalogBundle({
        orgId: ORG_ID,
        sourceId: SOURCE_ID,
        bundle,
      }),
    ).toMatchObject({
      snapshotState: "entries_ready",
      entriesImported: 1,
    });
    expect(
      (
        testDb
          .prepare(
            "SELECT enabled FROM skill_catalog_sources WHERE source_id = ?",
          )
          .get(SOURCE_ID) as { enabled: number }
      ).enabled,
    ).toBe(0);
  });
});
