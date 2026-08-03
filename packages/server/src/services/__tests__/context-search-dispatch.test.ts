import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { IntegrationResult, IntegrationSearchOpts } from "../../integrations/types.js";

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
  initializeKnowledgeGraph: vi.fn(),
  refreshAnalysis: vi.fn(),
  getRelevantLearnings: vi
    .fn()
    .mockReturnValue({ nodes: [], truncated: false, total_matching: 0, token_estimate: 0, edges: [] }),
  getPrecedents: vi.fn().mockReturnValue({ nodes: [] }),
  queryKnowledge: vi.fn(() => ({ nodes: [], edges: [], total_matching: 0, token_estimate: 0, truncated: false })),
}));

vi.mock("../../pim/llm.js", () => ({
  MODELS: { fast: "claude-haiku-4-5" },
  isLLMAvailable: vi.fn(() => true),
  callLLM: vi.fn(async () => "synthesized markdown"),
}));

// Each integration is mocked with a fn that records its IntegrationSearchOpts
// and returns an empty hits list — enough for searchContext to complete
// without making any network or DB calls during the integration phase.
vi.mock("../../integrations/jira.js", async () => {
  const actual = (await vi.importActual("../../integrations/jira.js")) as Record<string, unknown>;
  return {
    ...actual,
    searchJira: vi.fn(
      async (_opts: IntegrationSearchOpts): Promise<IntegrationResult> => ({ source: "jira", documents: [] }),
    ),
  };
});
vi.mock("../../integrations/slack.js", () => ({
  searchSlack: vi.fn(
    async (_opts: IntegrationSearchOpts): Promise<IntegrationResult> => ({ source: "slack", documents: [] }),
  ),
}));
vi.mock("../../integrations/github.js", () => ({
  searchGithub: vi.fn(
    async (_opts: IntegrationSearchOpts): Promise<IntegrationResult> => ({ source: "github", documents: [] }),
  ),
}));
vi.mock("../../integrations/git.js", () => ({
  searchGit: vi.fn(
    async (_opts: IntegrationSearchOpts): Promise<IntegrationResult> => ({ source: "git", documents: [] }),
  ),
}));
vi.mock("../../integrations/confluence.js", () => ({
  searchConfluence: vi.fn(
    async (_opts: IntegrationSearchOpts): Promise<IntegrationResult> => ({ source: "confluence", documents: [] }),
  ),
}));
vi.mock("../../integrations/fluffyjaws.js", () => ({
  searchFluffyjaws: vi.fn(
    async (_opts: IntegrationSearchOpts): Promise<IntegrationResult> => ({ source: "fluffyjaws", documents: [] }),
  ),
}));
vi.mock("../../integrations/kg.js", () => ({
  searchKG: vi.fn(
    async (_opts: IntegrationSearchOpts): Promise<IntegrationResult> => ({ source: "kg", documents: [] }),
  ),
}));

import { createTables } from "../../db/schema.js";
import { upsertUserByIms } from "../users.js";
import { createOrg } from "../orgs.js";
import { searchContext, cacheKey } from "../context-search.js";
import { searchJira } from "../../integrations/jira.js";
import { searchSlack } from "../../integrations/slack.js";
import { searchGithub } from "../../integrations/github.js";
import { searchGit } from "../../integrations/git.js";
import { searchConfluence } from "../../integrations/confluence.js";
import { searchFluffyjaws } from "../../integrations/fluffyjaws.js";
import { searchKG } from "../../integrations/kg.js";
import { callLLM } from "../../pim/llm.js";
import { indexProjectDocument } from "../project-search-index.js";

const TEST_ORG_ID = "org-test";
let userEmail: string;

beforeAll(() => {
  createTables();

  for (const k of [
    "SLACK_USER_TOKEN_MWP",
    "SLACK_USER_TOKEN_AEM_ENG",
    "SLACK_USER_TOKEN_ADOBEDOTCOM",
    "GH_TOKEN",
  ]) {
    delete process.env[k];
  }

  const creator = upsertUserByIms({ email: "creator@adobe.com", display_name: "Creator" });
  const u1 = upsertUserByIms({ email: "rea01581@adobe.com", display_name: "Rayyan Khan" });
  userEmail = u1.email;
  const org = createOrg({ orgId: TEST_ORG_ID, slug: "acme", name: "Acme", creatorUserId: creator.user_id });
  testDb
    .prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(org.org_id, u1.user_id, new Date().toISOString());
  testDb
    .prepare(
      "INSERT INTO projects (project_id, name, description, created_at, resources_json, org_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "proj_acme",
      "Acme Frontend",
      null,
      new Date().toISOString(),
      JSON.stringify({ jira: { project_keys: ["MWPW"] } }),
      org.org_id,
    );
});

beforeEach(() => {
  vi.mocked(searchJira).mockClear();
  vi.mocked(searchSlack).mockClear();
  vi.mocked(searchGithub).mockClear();
  vi.mocked(searchGit).mockClear();
  vi.mocked(searchConfluence).mockClear();
  vi.mocked(searchFluffyjaws).mockClear();
  vi.mocked(searchKG).mockClear();
  vi.mocked(callLLM).mockClear();
  testDb.exec("DELETE FROM identity_cache");
});

describe("searchContext per-integration opts", () => {
  it("delegates current actor-free project searches to indexed retrieval", async () => {
    indexProjectDocument({
      org_id: TEST_ORG_ID,
      project_id: "proj_acme",
      source: "jira",
      source_type: "issue",
      source_id: "MWPW-9001",
      title: "Indexed delegation marker",
      body: "delegationneedle is available only in the project index",
      visibility: "project_visible",
    });

    const result = await searchContext(
      {
        query: "delegationneedle",
        project_id: "proj_acme",
        sources: ["jira"],
        synthesize: false,
        use_cache: false,
      },
      TEST_ORG_ID,
    );

    expect(result.hits[0]).toMatchObject({ source: "jira", title: "Indexed delegation marker" });
    expect(vi.mocked(searchJira)).not.toHaveBeenCalled();
  });

  it("when IMS fallback fires, only Jira receives the actor; other sources stay broad", async () => {
    await searchContext(
      { query: "milo block init", synthesize: false, use_cache: false },
      TEST_ORG_ID,
      { authenticatedUserEmail: userEmail },
    );

    // Jira: gets the IMS-fallback actor (this is what satisfies the
    // fail-closed scope guard and the whole point of the fallback).
    const jiraCall = vi.mocked(searchJira).mock.calls[0]?.[0];
    expect(jiraCall?.actor?.email).toBe(userEmail);
    expect(jiraCall?.project_resources?.jira?.project_keys).toEqual(["MWPW"]);

    // Every other source: must NOT receive the actor — otherwise an
    // ad-hoc query would silently narrow to the caller's own messages,
    // commits, PRs.
    const others = [
      { name: "slack", mock: searchSlack },
      { name: "github", mock: searchGithub },
      { name: "git", mock: searchGit },
      { name: "confluence", mock: searchConfluence },
      { name: "fluffyjaws", mock: searchFluffyjaws },
      { name: "kg", mock: searchKG },
    ];
    for (const { name, mock } of others) {
      const call = vi.mocked(mock).mock.calls[0]?.[0];
      expect(call?.actor, `${name} must not receive the IMS-fallback actor`).toBeUndefined();
    }
  });

  it("when actor is explicit, every actor-aware source receives it (no Jira-only stripping)", async () => {
    await searchContext(
      {
        query: "milo block init",
        actor: { email: "someone-else@adobe.com" },
        synthesize: false,
        use_cache: false,
      },
      TEST_ORG_ID,
      { authenticatedUserEmail: userEmail },
    );

    const pairs: { name: string; mock: typeof searchJira }[] = [
      { name: "jira", mock: searchJira },
      { name: "slack", mock: searchSlack },
      { name: "github", mock: searchGithub },
      { name: "git", mock: searchGit },
      { name: "confluence", mock: searchConfluence },
      { name: "fluffyjaws", mock: searchFluffyjaws },
      { name: "kg", mock: searchKG },
    ];
    for (const { name, mock } of pairs) {
      const call = vi.mocked(mock).mock.calls[0]?.[0];
      expect(call?.actor?.email, `${name} should receive the explicit actor`).toBe(
        "someone-else@adobe.com",
      );
    }
  });

  it("when no auth user is passed, every source sees actor: undefined", async () => {
    await searchContext(
      { query: "milo block init", synthesize: false, use_cache: false },
      TEST_ORG_ID,
    );

    for (const mock of [searchJira, searchSlack, searchGithub, searchGit, searchConfluence, searchFluffyjaws, searchKG]) {
      const call = vi.mocked(mock).mock.calls[0]?.[0];
      expect(call?.actor).toBeUndefined();
    }
  });
});

describe("searchContext synthesis prompt", () => {
  // Give the Slack mock one hit so synthesize() takes the LLM path
  // instead of the deterministic zero-hits early return.
  beforeEach(() => {
    vi.mocked(searchSlack).mockImplementationOnce(async () => ({
      source: "slack",
      documents: [
        {
          org_id: TEST_ORG_ID,
          source: "slack",
          source_type: "message",
          source_id: "https://slack.example/x",
          source_url: "https://slack.example/x",
          title: "#milo-devs",
          snippet: "block init pattern discussion",
        },
      ],
    }));
  });

  it("omits actor from the synthesis prompt when IMS fallback fired", async () => {
    await searchContext(
      { query: "milo block init", use_cache: false },
      TEST_ORG_ID,
      { authenticatedUserEmail: userEmail },
    );

    expect(vi.mocked(callLLM)).toHaveBeenCalledOnce();
    const promptStr = vi.mocked(callLLM).mock.calls[0][0].prompt;
    const parsed = JSON.parse(promptStr) as { actor?: unknown };
    expect(parsed.actor).toBeUndefined();
  });

  it("passes actor to the synthesis prompt when caller supplied it explicitly", async () => {
    await searchContext(
      {
        query: "milo block init",
        actor: { email: "someone-else@adobe.com", display_name: "Someone Else" },
        use_cache: false,
      },
      TEST_ORG_ID,
      { authenticatedUserEmail: userEmail },
    );

    expect(vi.mocked(callLLM)).toHaveBeenCalledOnce();
    const promptStr = vi.mocked(callLLM).mock.calls[0][0].prompt;
    const parsed = JSON.parse(promptStr) as { actor?: { email?: string } };
    expect(parsed.actor?.email).toBe("someone-else@adobe.com");
  });

  it("zero-hits deterministic summary returns undefined under IMS fallback (no actor narrative)", async () => {
    // Override the slack mock so this test gets zero hits.
    vi.mocked(searchSlack).mockReset();
    vi.mocked(searchSlack).mockImplementation(async () => ({ source: "slack", documents: [] }));

    const result = await searchContext(
      { query: "milo block init", use_cache: false },
      TEST_ORG_ID,
      { authenticatedUserEmail: userEmail },
    );

    // Pre-fix this would have been "No matching activity found by Rayyan Khan for this query."
    expect(result.summary_md).toBeUndefined();
    expect(vi.mocked(callLLM)).not.toHaveBeenCalled();
  });
});

describe("cacheKey", () => {
  it("differs for IMS fallback vs explicit actor when actor.email is the same", () => {
    const req = { query: "milo block init" } as const;
    const actor = { email: userEmail };
    const fallbackKey = cacheKey(req, { actor, fallback: "authenticated_user" }, TEST_ORG_ID);
    const explicitKey = cacheKey(req, { actor }, TEST_ORG_ID);
    expect(fallbackKey).not.toBe(explicitKey);
  });

  it("is stable for the same scope shape", () => {
    const req = { query: "milo block init" } as const;
    const scope = { actor: { email: userEmail }, fallback: "authenticated_user" as const };
    expect(cacheKey(req, scope, TEST_ORG_ID)).toBe(cacheKey(req, scope, TEST_ORG_ID));
  });

  it("differs across org_ids for the same query+scope (cache cannot leak across orgs)", () => {
    const req = { query: "milo block init" } as const;
    const scope = { actor: { email: userEmail } };
    expect(cacheKey(req, scope, "org-a")).not.toBe(cacheKey(req, scope, "org-b"));
  });
});
