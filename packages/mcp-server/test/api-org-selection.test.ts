import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";

process.env.PIM_API_URL = "http://pim.test";

const api = await import("../src/api.ts");

type FetchCall = { url: string; init?: RequestInit };

const orgs = [
  { org_id: "org_adobe", slug: "adobecom", name: "Adobecom", role: "member" as const, created_at: "2026-01-01T00:00:00.000Z" },
  { org_id: "org_beta", slug: "beta", name: "Beta", role: "admin" as const, created_at: "2026-01-02T00:00:00.000Z" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "pim-mcp-org-"));
  delete process.env.PIM_ORG_SLUG;
  api._resetOrgSelectionForTests();
});

test("one org and no configured slug auto-selects and sends X-Pim-Org", async () => {
  const calls = installFetch((url) => {
    if (url.endsWith("/api/health")) return jsonResponse({ auth_mode: "trust" });
    if (url.endsWith("/api/me")) return jsonResponse({ orgs: [orgs[0]] });
    if (url.endsWith("/api/org/config")) return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${url}`);
  });

  await api.apiFetch("/api/org/config");

  const configCall = calls.find((c) => c.url.endsWith("/api/org/config"));
  assert.equal((configCall?.init?.headers as Record<string, string>)["X-Pim-Org"], "adobecom");
  const saved = JSON.parse(readFileSync(path.join(process.env.HOME!, ".pim", "config.json"), "utf-8")) as {
    active_org_slug?: string;
  };
  assert.equal(saved.active_org_slug, "adobecom");
});

test("multiple orgs and no configured slug returns needs_org_selection", async () => {
  installFetch((url) => {
    if (url.endsWith("/api/health")) return jsonResponse({ auth_mode: "trust" });
    if (url.endsWith("/api/me")) return jsonResponse({ orgs });
    throw new Error(`Unexpected URL ${url}`);
  });

  await assert.rejects(
    () => api.apiFetch("/api/org/config"),
    (err) => {
      const parsed = JSON.parse((err as Error).message) as { needs_org_selection?: boolean; orgs?: unknown[] };
      assert.equal(parsed.needs_org_selection, true);
      assert.equal(parsed.orgs?.length, 2);
      return true;
    },
  );
});

test("set_active_org persists and subsequent calls send X-Pim-Org", async () => {
  const calls = installFetch((url) => {
    if (url.endsWith("/api/health")) return jsonResponse({ auth_mode: "trust" });
    if (url.endsWith("/api/me")) return jsonResponse({ orgs });
    if (url.endsWith("/api/org/config")) return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${url}`);
  });

  const result = await api.setActiveOrg("adobecom");
  assert.equal(result.selected_org.slug, "adobecom");

  const configPath = path.join(process.env.HOME!, ".pim", "config.json");
  const saved = JSON.parse(readFileSync(configPath, "utf-8")) as { active_org_slug?: string };
  assert.equal(saved.active_org_slug, "adobecom");
  assert.equal(statSync(configPath).mode & 0o077, 0);

  await api.apiFetch("/api/org/config");
  const configCall = calls.find((c) => c.url.endsWith("/api/org/config"));
  assert.equal((configCall?.init?.headers as Record<string, string>)["X-Pim-Org"], "adobecom");
});

test("trust mode with PIM_ORG_SLUG still sends the org header", async () => {
  process.env.PIM_ORG_SLUG = "adobecom";
  const calls = installFetch((url) => {
    if (url.endsWith("/api/health")) return jsonResponse({ auth_mode: "trust" });
    if (url.endsWith("/api/org/config")) return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${url}`);
  });

  await api.apiFetch("/api/org/config");

  const configCall = calls.find((c) => c.url.endsWith("/api/org/config"));
  assert.equal((configCall?.init?.headers as Record<string, string>)["X-Pim-Org"], "adobecom");
  assert.equal(calls.some((c) => c.url.endsWith("/api/me")), false);
});
