import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import db from "../../db/connection.js";
import { createTables } from "../../db/schema.js";
import {
  buildConfluenceScopeCql,
  pollConfluenceSource,
  splitConfluenceSections,
  syncConfluenceProjectSource,
  validateConfluenceNextUrl,
} from "../project-confluence-source.js";
import { createOrg } from "../orgs.js";
import { upsertUserByIms } from "../users.js";

const ORG_ID = "org-confluence";
const PROJECT_ID = "project-confluence";
const SYNC_ORG_ID = "org-confluence-failure";
const SYNC_PROJECT_ID = "project-confluence-failure";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("Confluence project source", () => {
  beforeAll(() => {
    createTables();
    const creator = upsertUserByIms({
      email: "confluence-failure-test@example.test",
      display_name: "Confluence Failure Test",
    });
    createOrg({
      orgId: SYNC_ORG_ID,
      slug: "confluence-failure-test",
      name: "Confluence Failure Test",
      creatorUserId: creator.user_id,
    });
    db.prepare(
      `INSERT INTO projects
         (project_id, name, description, created_at, resources_json, org_id, created_by_user_id)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      SYNC_PROJECT_ID,
      "Confluence Failure Test",
      new Date().toISOString(),
      JSON.stringify({ confluence: { space_keys: ["ENG"] } }),
      SYNC_ORG_ID,
      creator.user_id,
    );
  });

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
    const cql = buildConfluenceScopeCql({
      confluence: {
        space_keys: ["ENG"],
        page_urls: ["https://docs.example.test/wiki/spaces/ENG/pages/123/Plan"],
      },
    });
    expect(cql).toBe('type = page AND (space in ("ENG") OR id in ("123")) ORDER BY lastmodified ASC');
    expect(cql).not.toContain("status");
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

  it.each([
    ["decimal out of range", "&#1114112;", "�"],
    ["hexadecimal out of range", "&#x110000;", "�"],
    ["zero", "&#0;", "�"],
    ["surrogate", "&#xD800;", "�"],
    ["C1 control", "&#128;", "€"],
    ["supplementary code point", "&#x1F642;", "🙂"],
    ["named entity", "&copy;", "©"],
    ["unknown named entity", "&zzzzDefinitelyUnknown;", "&zzzzDefinitelyUnknown;"],
    ["double encoded numeric reference", "&amp;#1114112;", "&#1114112;"],
  ])("decodes %s exactly once without throwing", (_name, encoded, expected) => {
    const sections = splitConfluenceSections(`<p>${encoded}</p>`);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.body).toBe(expected);
    expect(sections[0]?.body).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("continues a complete poll after malformed references on an earlier page", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/restriction/byOperation/read")) {
        return json({ restrictions: { user: { size: 0, results: [] }, group: { size: 0, results: [] } } });
      }
      return json({
        results: [
          {
            id: "malformed-1",
            title: "Malformed references",
            space: { key: "ENG" },
            ancestors: [],
            version: { number: 1 },
            body: { storage: { value: "<p>&#1114112; &#x110000; &#xD800; &amp;#1114112;</p>" } },
          },
          {
            id: "normal-2",
            title: "Normal page",
            space: { key: "ENG" },
            ancestors: [],
            version: { number: 1 },
            body: { storage: { value: "<p>Still indexed.</p>" } },
          },
        ],
      });
    });

    const result = await pollConfluenceSource(
      ORG_ID,
      PROJECT_ID,
      { confluence: { space_keys: ["ENG"] } },
      { fetch: fetchMock as typeof fetch },
    );

    expect(result.complete).toBe(true);
    expect(result.missing).toBeUndefined();
    expect(result.seen_page_ids).toEqual(["malformed-1", "normal-2"]);
    expect(result.changes).toHaveLength(2);
    expect(JSON.stringify(result.changes)).toContain("Still indexed.");
  });

  it("discards accumulated changes and does not advance the watermark after a pagination failure", async () => {
    db.prepare("DELETE FROM project_evidence_items WHERE org_id = ? AND project_id = ?")
      .run(SYNC_ORG_ID, SYNC_PROJECT_ID);
    db.prepare("DELETE FROM project_ingestion_cursors WHERE org_id = ? AND project_id = ?")
      .run(SYNC_ORG_ID, SYNC_PROJECT_ID);
    db.prepare("DELETE FROM project_source_sync_state WHERE org_id = ? AND project_id = ?")
      .run(SYNC_ORG_ID, SYNC_PROJECT_ID);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/restriction/byOperation/read")) {
        return json({ restrictions: { user: { size: 0, results: [] }, group: { size: 0, results: [] } } });
      }
      if (url.searchParams.get("cursor") === "next-page") {
        return new Response("upstream unavailable", { status: 503 });
      }
      return json({
        results: [{
          id: "page-before-failure",
          title: "Must not be applied",
          space: { key: "ENG" },
          ancestors: [],
          version: { number: 1, when: "2026-08-05T00:00:00.000Z" },
          body: { storage: { value: "<p>Accumulated but discarded.</p>" } },
        }],
        _links: { next: "/wiki/rest/api/content/search?cursor=next-page" },
      });
    });

    const result = await syncConfluenceProjectSource(
      SYNC_ORG_ID,
      SYNC_PROJECT_ID,
      { confluence: { space_keys: ["ENG"] } },
      { fetch: fetchMock as typeof fetch, sleep: vi.fn(async () => undefined) },
    );

    expect(result).toMatchObject({ ingested: 0, deleted: 0, missing: "confluence_http_503" });
    expect(db.prepare(
      "SELECT count(*) AS count FROM project_evidence_items WHERE org_id = ? AND project_id = ?",
    ).get(SYNC_ORG_ID, SYNC_PROJECT_ID)).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT cursor_value FROM project_ingestion_cursors
       WHERE org_id = ? AND project_id = ? AND source = 'confluence'`,
    ).get(SYNC_ORG_ID, SYNC_PROJECT_ID)).toBeUndefined();
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
    const initialSearch = new URL(calls[0]);
    expect(initialSearch.searchParams.get("status")).toBe("current");
    expect(initialSearch.searchParams.get("cql")).not.toContain("status");
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
