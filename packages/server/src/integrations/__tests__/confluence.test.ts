import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchConfluence } from "../confluence.js";

const BASE_OPTS = {
  query: "release plan",
  time_window_days: 90,
  max_hits_per_source: 10,
  org_id: "org-1",
  project_id: "project-1",
};

describe("project-scoped Confluence live search", () => {
  beforeEach(() => {
    process.env.PROJECT_CONFLUENCE_SEARCH_ENABLED = "1";
    process.env.CONFLUENCE_BASE_URL = "https://example.atlassian.net/wiki";
    process.env.CONFLUENCE_TOKEN = "test-token";
    process.env.CONFLUENCE_EMAIL = "reader@example.test";
    process.env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS = "ENG";
    process.env.CONFLUENCE_PROJECT_VISIBLE_PAGE_IDS = "123";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PROJECT_CONFLUENCE_SEARCH_ENABLED;
    delete process.env.CONFLUENCE_BASE_URL;
    delete process.env.CONFLUENCE_TOKEN;
    delete process.env.CONFLUENCE_EMAIL;
    delete process.env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS;
    delete process.env.CONFLUENCE_PROJECT_VISIBLE_PAGE_IDS;
  });

  it("fails closed without an explicit project binding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchConfluence({ ...BASE_OPTS, project_resources: {} });

    expect(result.documents).toEqual([]);
    expect(result.missing).toMatch(/bound to this project/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("admits a configured page only after an empty read-restriction probe", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{
          id: "123",
          title: "Release plan",
          space: { key: "ENG" },
          ancestors: [],
          body: { view: { value: "<p>Ship the new console in August.</p>" } },
          history: { lastUpdated: { when: "2026-07-01T00:00:00.000Z" } },
          _links: { webui: "/spaces/ENG/pages/123" },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        restrictions: {
          user: { size: 0, results: [] },
          group: { size: 0, results: [] },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchConfluence({
      ...BASE_OPTS,
      project_resources: { confluence: { page_ids: ["123"] } },
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      source_id: "123",
      title: "Release plan",
      snippet: "Ship the new console in August.",
      metadata: { page_id: "123", visibility: "project_visible" },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("id%20in%20(%22123%22)");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/content/123/restriction/byOperation/read");
  });

  it("excludes restricted pages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ id: "456", title: "Private plan", space: { key: "ENG" }, ancestors: [], body: { view: { value: "secret roadmap" } } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        restrictions: {
          user: { size: 1, results: [{ accountId: "restricted-user" }] },
          group: { size: 0, results: [] },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchConfluence({
      ...BASE_OPTS,
      project_resources: { confluence: { space_keys: ["ENG"] } },
    });

    expect(result.documents).toEqual([]);
  });

  it("excludes a page when an ancestor has a read restriction", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{
          id: "789",
          title: "Inherited private plan",
          space: { key: "ENG" },
          ancestors: [{ id: "10" }],
          body: { view: { value: "must remain private" } },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        restrictions: {
          user: { size: 1, results: [{ accountId: "ancestor-reader" }] },
          group: { size: 0, results: [] },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchConfluence({
      ...BASE_OPTS,
      project_resources: { confluence: { space_keys: ["ENG"] } },
    });

    expect(result.documents).toEqual([]);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/content/10/restriction/byOperation/read");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when no operator visibility policy is configured", async () => {
    delete process.env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS;
    delete process.env.CONFLUENCE_PROJECT_VISIBLE_PAGE_IDS;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchConfluence({
      ...BASE_OPTS,
      project_resources: { confluence: { space_keys: ["ENG"] } },
    });

    expect(result.documents).toEqual([]);
    expect(result.missing).toMatch(/visibility policy/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not echo an upstream response body in an operational error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "password=do-not-leak-this-value",
      { status: 403 },
    )));

    const result = await searchConfluence({
      ...BASE_OPTS,
      project_resources: { confluence: { space_keys: ["ENG"] } },
    });

    expect(result.missing).toBe("Confluence request failed (403)");
    expect(result.missing).not.toContain("do-not-leak");
  });
});
