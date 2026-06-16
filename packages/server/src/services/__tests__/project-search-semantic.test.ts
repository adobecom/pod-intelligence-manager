import { describe, it, expect, beforeEach, vi } from "vitest";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return { testDb: db };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../knowledge-graph.js", () => ({
  queryKnowledge: vi.fn(() => ({ nodes: [], edges: [], total_matching: 0, token_estimate: 0, truncated: false })),
}));

// Deterministic, offline embedding: a bag-of-vocab vector. Lets us exercise the
// real cosine + fusion path without a live Bedrock call.
vi.mock("../embeddings.js", () => {
  const crypto = require("node:crypto");
  const VOCAB = ["rbac", "scope", "session", "webhook", "billing", "stripe", "console", "timeout", "access", "control"];
  const embed = (text: string): number[] => {
    const t = text.toLowerCase();
    const v: number[] = VOCAB.map((w) => (t.includes(w) ? 1 : 0));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  };
  return {
    isEmbeddingAvailable: () => true,
    generateEmbedding: vi.fn(async (t: string) => embed(t)),
    embeddingTextHash: (t: string) => crypto.createHash("sha256").update(t).digest("hex"),
    cosineSimilarity: (a: number[], b: number[]) => {
      if (a.length !== b.length) return 0;
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      const d = Math.sqrt(na) * Math.sqrt(nb);
      return d === 0 ? 0 : dot / d;
    },
  };
});

import { createTables } from "../../db/schema.js";
import { upsertUserByIms } from "../users.js";
import { createOrg } from "../orgs.js";
import { embedProjectSearchChunks, indexProjectDocument } from "../project-search-index.js";
import { searchProject } from "../project-search.js";

const ORG_ID = "org_sem";
const PROJECT_ID = "project-sem";

beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE IF EXISTS project_search_fts;
    DROP TABLE IF EXISTS project_search_edges;
    DROP TABLE IF EXISTS project_search_entities;
    DROP TABLE IF EXISTS project_search_chunks;
    DROP TABLE IF EXISTS project_search_documents;
    DROP TABLE IF EXISTS projects;
    DROP TABLE IF EXISTS memberships;
    DROP TABLE IF EXISTS org_settings;
    DROP TABLE IF EXISTS orgs;
    DROP TABLE IF EXISTS users;
    PRAGMA foreign_keys = ON;
  `);
  createTables();
  const creator = upsertUserByIms({ email: "sem@local", display_name: "Sem" });
  createOrg({ orgId: ORG_ID, slug: "sem", name: "Sem", creatorUserId: creator.user_id });
  testDb
    .prepare("INSERT INTO projects (project_id, name, description, created_at, resources_json, org_id, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(PROJECT_ID, "Sem", null, new Date().toISOString(), "{}", ORG_ID, creator.user_id);
});

describe("indexed project search — semantic path", () => {
  it("embeds chunks and runs in hybrid mode with full coverage", async () => {
    indexProjectDocument({
      org_id: ORG_ID, project_id: PROJECT_ID, source: "jira", source_type: "issue",
      source_id: "EMC-1", title: "RBAC scope enforcement",
      body: "Scope-level access control for sessions in the console.",
      occurred_at: new Date().toISOString(),
    });

    const embedded = await embedProjectSearchChunks(ORG_ID, PROJECT_ID);
    expect(embedded).toBeGreaterThanOrEqual(1);

    const res = await searchProject(ORG_ID, PROJECT_ID, { query: "access control scope" });
    expect(res!.retrieval_mode).toBe("hybrid");
    expect(res!.embedding_coverage).toBe(1);
    expect(res!.hits.length).toBeGreaterThanOrEqual(1);
    expect(res!.hits.some((h) => h.matched.semantic)).toBe(true);
  });

  it("re-embedding is incremental — unchanged chunks are skipped", async () => {
    indexProjectDocument({
      org_id: ORG_ID, project_id: PROJECT_ID, source: "jira", source_type: "issue",
      source_id: "EMC-2", title: "Webhook timeout", body: "Webhook receiver timeout handling.",
      occurred_at: new Date().toISOString(),
    });
    const first = await embedProjectSearchChunks(ORG_ID, PROJECT_ID);
    expect(first).toBeGreaterThanOrEqual(1);
    const second = await embedProjectSearchChunks(ORG_ID, PROJECT_ID);
    expect(second).toBe(0);
  });
});
