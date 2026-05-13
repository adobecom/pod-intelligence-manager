import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { searchJira } from "../jira.js";
import type { IntegrationSearchOpts } from "../types.js";

// Minimum opts the Jira integration expects; tests override per case.
function baseOpts(overrides: Partial<IntegrationSearchOpts> = {}): IntegrationSearchOpts {
  return {
    query: "milo block init",
    time_window_days: 90,
    max_hits_per_source: 10,
    org_id: "org-test",
    ...overrides,
  };
}

function emptyJiraResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ issues: [] }),
    text: async () => "",
  } as unknown as Response;
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.JIRA_BASE_URL = "https://jira.corp.adobe.com";
  process.env.JIRA_TOKEN = "test-pat";
  delete process.env.JIRA_EMAIL;
  globalThis.fetch = vi.fn().mockResolvedValue(emptyJiraResponse());
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("searchJira fail-closed scope guard", () => {
  it("refuses an unscoped query (no project, no actor, no fixVersion)", async () => {
    const res = await searchJira(baseOpts());
    expect(res.source).toBe("jira");
    expect(res.hits).toEqual([]);
    expect(res.missing).toMatch(/refused/i);
    expect(res.missing).toMatch(/project|actor|version/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("runs when project_keys is provided", async () => {
    const res = await searchJira(
      baseOpts({
        project_resources: { jira: { project_keys: ["MWPW"] } },
      }),
    );
    expect(res.missing).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body) as { jql: string };
    expect(body.jql).toContain('project in ("MWPW")');
  });

  it("runs when only a Jira Team is configured (team-only onboarded projects)", async () => {
    const res = await searchJira(
      baseOpts({
        project_resources: { jira: { team: "Strata" } },
      }),
    );
    expect(res.missing).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body) as { jql: string };
    expect(body.jql).toContain('"Team" = "Strata"');
    expect(body.jql).not.toContain("project in");
  });

  it("runs when only an actor email is provided", async () => {
    const res = await searchJira(
      baseOpts({
        actor: { email: "rea01581@adobe.com" },
      }),
    );
    expect(res.missing).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body) as { jql: string };
    expect(body.jql).toContain('assignee = "rea01581@adobe.com"');
    expect(body.jql).toContain('reporter = "rea01581@adobe.com"');
    expect(body.jql).toContain('creator = "rea01581@adobe.com"');
  });

  it("runs when the query carries a fixVersion token", async () => {
    const res = await searchJira(
      baseOpts({ query: "what's in T3-26.16" }),
    );
    expect(res.missing).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body) as { jql: string };
    expect(body.jql).toContain('fixVersion in ("T3-26.16")');
    // fixVersion path skips the updated-window clause
    expect(body.jql).not.toMatch(/updated >=/);
  });

  it("combines project, actor, and fixVersion in JQL when all are present", async () => {
    const res = await searchJira(
      baseOpts({
        query: "T3-26.16 milo blocks",
        project_resources: { jira: { project_keys: ["MWPW", "DOTCOM"] } },
        actor: { email: "rea01581@adobe.com" },
      }),
    );
    expect(res.missing).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body) as { jql: string };
    expect(body.jql).toContain('project in ("MWPW", "DOTCOM")');
    expect(body.jql).toContain('fixVersion in ("T3-26.16")');
    expect(body.jql).toContain('assignee = "rea01581@adobe.com"');
  });

  it("still returns the creds-missing reason when JIRA_TOKEN is unset (refuse only when authenticated)", async () => {
    delete process.env.JIRA_TOKEN;
    const res = await searchJira(baseOpts());
    expect(res.missing).toMatch(/JIRA_BASE_URL or JIRA_TOKEN not set/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
