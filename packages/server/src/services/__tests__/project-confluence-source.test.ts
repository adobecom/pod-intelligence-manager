import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConfluenceScopeCql,
  pollConfluenceSource,
  splitConfluenceSections,
  validateConfluenceNextUrl,
} from "../project-confluence-source.js";

const ORG_ID = "org-confluence";
const PROJECT_ID = "project-confluence";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("Confluence project source", () => {
  beforeEach(() => {
    process.env.CONFLUENCE_BASE_URL = "https://docs.example.test/wiki";
    process.env.CONFLUENCE_TOKEN = "test-token";
    process.env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS = "ENG";
  });

  afterEach(() => {
    delete process.env.CONFLUENCE_BASE_URL;
    delete process.env.CONFLUENCE_TOKEN;
    delete process.env.CONFLUENCE_EMAIL;
    delete process.env.JIRA_EMAIL;
    delete process.env.CONFLUENCE_MAX_PAGES;
    delete process.env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS;
    delete process.env.CONFLUENCE_PROJECT_VISIBLE_PAGE_IDS;
  });

  it("builds a fail-closed CQL scope from spaces and page bindings", () => {
    expect(buildConfluenceScopeCql({})).toBeNull();
    expect(buildConfluenceScopeCql({
      confluence: {
        space_keys: ["ENG"],
        page_urls: ["https://docs.example.test/wiki/spaces/ENG/pages/123/Plan"],
      },
    })).toContain('(space in ("ENG") OR id in ("123"))');
  });

  it("splits storage HTML by heading hierarchy and preserves adjacency", () => {
    const sections = splitConfluenceSections([
      "<p>Intro text</p>",
      "<h1>Release</h1><p>August train.</p>",
      "<h2>Risks</h2><ul><li>Migration window</li></ul>",
      "<h1>Runbook</h1><p>Follow the checklist.</p>",
    ].join(""));

    expect(sections.map((section) => section.heading)).toEqual(["Overview", "Release", "Risks", "Runbook"]);
    expect(sections[2].headingPath).toEqual(["Release", "Risks"]);
    expect(sections[2].body).toContain("Migration window");
  });

  it("paginates, verifies unrestricted visibility, and emits stable section changes", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname.endsWith("/restriction/byOperation/read")) {
        return json({ restrictions: { user: { size: 0, results: [] }, group: { size: 0, results: [] } } });
      }
      if (url.searchParams.get("cursor") === "next-page") {
        return json({
          results: [{
            id: "200",
            title: "Runbook",
            space: { key: "ENG" },
            ancestors: [],
            version: { number: 4, when: "2026-07-02T00:00:00.000Z" },
            body: { storage: { value: "<h1>Deploy</h1><p>Run checks.</p>" } },
            _links: { webui: "/wiki/spaces/ENG/pages/200" },
          }],
        });
      }
      return json({
        results: [{
          id: "100",
          title: "Release Plan",
          space: { key: "ENG" },
          ancestors: [],
          version: { number: 7, when: "2026-07-01T00:00:00.000Z", by: { displayName: "Ada" } },
          body: { storage: { value: "<h1>Status</h1><p>Ready. token=confluence-secret-value</p><h2>Risks</h2><p>None.</p>" } },
          _links: { webui: "/wiki/spaces/ENG/pages/100" },
        }],
        _links: { next: "/wiki/rest/api/content/search?cursor=next-page" },
      });
    });

    const result = await pollConfluenceSource(
      ORG_ID,
      PROJECT_ID,
      { confluence: { space_keys: ["ENG"] } },
      { fetch: fetchMock as typeof fetch, sleep: vi.fn(async () => undefined), pageLimit: 1 },
    );

    expect(result.complete).toBe(true);
    expect(result.seen_page_ids).toEqual(["100", "200"]);
    expect(result.pages_admitted).toBe(2);
    expect(result.changes).toHaveLength(3);
    expect(JSON.stringify(result.changes)).not.toContain("confluence-secret-value");
    expect(JSON.stringify(result.changes)).toContain("[REDACTED:Generic Secret]");
    expect(result.changes[0]).toMatchObject({
      kind: "upsert",
      source: "confluence",
      source_instance: "docs.example.test/wiki",
      native_id: "100:section:status-1",
      visibility: "project_visible",
      evidence: {
        source_type: "page_section",
        author: "Ada",
        metadata: {
          page_id: "100",
          section_index: 0,
          next_native_id: "100:section:status-risks-1",
        },
      },
    });
    expect(calls.some((url) => url.includes("cursor=next-page"))).toBe(true);
  });

  it("excludes a content-restricted page without emitting its body", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/restriction/byOperation/read")) {
        return json({
          restrictions: {
            user: { size: 1, results: [{ accountId: "only-me" }] },
            group: { size: 0, results: [] },
          },
        });
      }
      return json({
        results: [{
          id: "private-1",
          title: "Private",
          space: { key: "ENG" },
          version: { number: 1 },
          body: { storage: { value: "<p>password=must-not-persist</p>" } },
        }],
      });
    });

    const result = await pollConfluenceSource(
      ORG_ID,
      PROJECT_ID,
      { confluence: { page_ids: ["private-1"] } },
      { fetch: fetchMock as typeof fetch },
    );

    expect(result.changes).toEqual([]);
    expect(result.ineligible_page_ids).toEqual(["private-1"]);
  });

  it("excludes pages with inherited read restrictions", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/content/parent-1/restriction/")) {
        return json({
          restrictions: {
            user: { size: 0, results: [] },
            group: { size: 1, results: [{ name: "private-team" }] },
          },
        });
      }
      if (url.pathname.endsWith("/restriction/byOperation/read")) {
        return json({ restrictions: { user: { size: 0, results: [] }, group: { size: 0, results: [] } } });
      }
      return json({
        results: [{
          id: "child-1",
          title: "Inherited private",
          space: { key: "ENG" },
          ancestors: [{ id: "parent-1" }],
          version: { number: 1 },
          body: { storage: { value: "<p>must-not-be-indexed</p>" } },
        }],
      });
    });

    const result = await pollConfluenceSource(
      ORG_ID,
      PROJECT_ID,
      { confluence: { space_keys: ["ENG"] } },
      { fetch: fetchMock as typeof fetch },
    );

    expect(result.changes).toEqual([]);
    expect(result.ineligible_page_ids).toEqual(["child-1"]);
  });

  it("rejects cross-origin and unexpected-path pagination URLs", () => {
    expect(validateConfluenceNextUrl(
      "https://docs.example.test/wiki/",
      "/wiki/rest/api/content/search?cursor=ok",
    )?.searchParams.get("cursor")).toBe("ok");
    expect(validateConfluenceNextUrl(
      "https://docs.example.test/wiki/",
      "https://attacker.example/rest/api/content/search?cursor=stolen",
    )).toBeNull();
    expect(validateConfluenceNextUrl(
      "https://docs.example.test/wiki/",
      "/wiki/rest/api/user?cursor=nope",
    )).toBeNull();
  });

  it("honors Retry-After for bounded retries", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(json({ results: [] }));

    const result = await pollConfluenceSource(
      ORG_ID,
      PROJECT_ID,
      { confluence: { space_keys: ["ENG"] } },
      { fetch: fetchMock as typeof fetch, sleep },
    );

    expect(result.complete).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
