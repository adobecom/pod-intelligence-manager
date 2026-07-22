import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { testDb, recordProjectEvidence, broadcastToAll } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  return {
    testDb: database,
    recordProjectEvidence: vi.fn(async () => ({})),
    broadcastToAll: vi.fn(),
  };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../project-memory.js", () => ({ recordProjectEvidence }));
vi.mock("../memory-enrichment.js", () => ({
  buildProjectContextUpdateMemory: vi.fn(() => ({ retrieval_text: "normalized memory", entity_refs: [] })),
  recordTemporalRelationshipsForUpdate: vi.fn(),
}));
vi.mock("../../ws/index.js", () => ({ broadcastToAll }));
vi.mock("../git-hook-enrichment.js", () => ({ scheduleProjectGitHookEnrichment: vi.fn() }));

import { createTables } from "../../db/schema.js";
import { ingestProjectContextUpdate } from "../project-ingestion.js";

const ORG_ID = "org-project-ingestion";
const USER_ID = "user-project-ingestion";
const PROJECT_ID = "project-ingestion";
const NOW = "2026-07-19T12:00:00.000Z";

beforeAll(() => {
  createTables();
  testDb.prepare(
    `INSERT INTO users
       (user_id, ims_user_id, email, display_name, is_service, created_at, last_login_at)
     VALUES (?, NULL, 'project-ingestion@example.test', 'Project Ingestion', 0, ?, ?)`,
  ).run(USER_ID, NOW, NOW);
  testDb.prepare(
    "INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(ORG_ID, "project-ingestion", "Project Ingestion", USER_ID, NOW);
  testDb.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, resources_json, org_id, created_by_user_id)
     VALUES (?, 'Ingestion Project', NULL, ?, '{}', '{}', ?, ?)`,
  ).run(PROJECT_ID, NOW, ORG_ID, USER_ID);
});

afterAll(() => {
  testDb.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.prepare("DELETE FROM project_context_updates WHERE project_id = ?").run(PROJECT_ID);
  testDb.prepare("DELETE FROM project_evidence_items WHERE project_id = ?").run(PROJECT_ID);
});

describe("project context ingestion persistence boundary", () => {
  it("rejects secrets anywhere in nested input, including a URL hidden behind an artifact path", async () => {
    const githubToken = `github_pat_${"A".repeat(24)}`;
    const rawUrlSecret = "signed-url-secret";
    const result = await ingestProjectContextUpdate(PROJECT_ID, {
      agent_id: "agent-safe",
      type: "question",
      scope: "backend",
      summary: "Need a deployment decision",
      details: "The implementation is ready for review.",
      artifacts: [{
        type: "file",
        path: "src/safe.ts",
        url: `https://artifacts.example.test/build?access_token=${rawUrlSecret}`,
      }],
      status: "blocked",
      blocks: ["release"],
      blocked_by: [],
      needs_input_from: [{ role: "security", question: `Can we use ${githubToken}?` }],
      source: "manual",
    });

    expect(result).toMatchObject({
      success: false,
      error: "Context update rejected: potential secrets detected",
    });
    expect(result.secretFindings).toEqual(expect.arrayContaining(["GitHub Token", "URL Credential"]));
    expect(recordProjectEvidence).not.toHaveBeenCalled();
    expect(broadcastToAll).not.toHaveBeenCalled();
    expect((testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_context_updates WHERE project_id = ?",
    ).get(PROJECT_ID) as { count: number }).count).toBe(0);
    expect(JSON.stringify(testDb.prepare(
      "SELECT * FROM project_context_updates WHERE project_id = ?",
    ).all(PROJECT_ID))).not.toContain(githubToken);
    expect(JSON.stringify(testDb.prepare(
      "SELECT * FROM project_context_updates WHERE project_id = ?",
    ).all(PROJECT_ID))).not.toContain(rawUrlSecret);
  });

  it("uses the canonicalized update for persistence and downstream boundaries", async () => {
    const result = await ingestProjectContextUpdate(PROJECT_ID, {
      agent_id: "  agent-clean  ",
      type: "progress",
      scope: " backend ",
      summary: "  Canonical update  ",
      details: "Line one.  \r\nLine two.\t ",
      artifacts: [{ type: " file ", path: " src/index.ts " }],
      status: "in_progress",
      blocks: [" release "],
      blocked_by: [],
      needs_input_from: [{ role: " security ", question: " Review the change. " }],
      source: "manual",
    });

    expect(result.success).toBe(true);
    expect(result.update).toMatchObject({
      agent_id: "agent-clean",
      scope: "backend",
      summary: "Canonical update",
      details: "Line one.\nLine two.",
      artifacts: [{ type: "file", path: "src/index.ts" }],
      blocks: ["release"],
      needs_input_from: [{ role: "security", question: "Review the change." }],
    });
    expect(recordProjectEvidence).toHaveBeenCalledWith(expect.objectContaining({
      source_title: "Canonical update",
      author: "agent-clean",
    }));
  });
});
