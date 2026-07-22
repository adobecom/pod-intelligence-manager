import type { SearchDocument } from "@pim/shared";
import {
  type IntegrationResult,
  type IntegrationSearchOpts,
  truncate,
} from "./types.js";
import {
  hasConfluenceProjectVisibilityPolicy,
  isConfluenceCandidateProjectVisible,
} from "./confluence-visibility.js";

// Atlassian Confluence REST /content/search with CQL. Supports two flavors:
//   - Adobe on-prem (wiki.corp.adobe.com): Authorization: Bearer <PAT>.
//   - Atlassian Cloud: Basic email:token base64.
// Selects by hostname + presence of an email.

interface ConfluencePage {
  id: string;
  title?: string;
  space?: { key?: string };
  ancestors?: Array<{ id?: string }>;
  _links?: { webui?: string };
  history?: { createdBy?: { displayName?: string }; createdDate?: string; lastUpdated?: { when?: string } };
  body?: { view?: { value?: string }; storage?: { value?: string } };
}

interface ConfluenceSearchResponse {
  results?: ConfluencePage[];
}

interface ConfluenceRestrictionResult {
  restrictions?: {
    user?: { size?: number; totalSize?: number; results?: unknown[] };
    group?: { size?: number; totalSize?: number; results?: unknown[] };
  };
}

function escapeCql(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function configuredPageIds(opts: IntegrationSearchOpts): string[] {
  const configured = opts.project_resources?.confluence;
  const ids = new Set((configured?.page_ids ?? []).map((id) => id.trim()).filter(Boolean));
  for (const raw of configured?.page_urls ?? []) {
    try {
      const url = new URL(raw);
      const match = url.pathname.match(/(?:\/pages\/|pageId=)(\d+)/i) ?? url.search.match(/[?&]pageId=(\d+)/i);
      if (match?.[1]) ids.add(match[1]);
    } catch {
      // Invalid configured URLs are ignored, leaving the connector fail-closed.
    }
  }
  return [...ids];
}

function restrictionCount(value: ConfluenceRestrictionResult): number {
  const user = value.restrictions?.user;
  const group = value.restrictions?.group;
  const count = (entry: typeof user) => entry?.totalSize ?? entry?.size ?? entry?.results?.length ?? 0;
  return count(user) + count(group);
}

/** A project-scoped live result is admitted only after Confluence proves that
 * the page has no content-level read restrictions. A failed probe is excluded. */
async function isProjectVisible(
  base: string,
  page: ConfluencePage,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isConfluenceCandidateProjectVisible(page)) return false;
  if (!Array.isArray(page.ancestors)) return false;
  const contentIds = [...new Set([
    ...(page.ancestors ?? []).map((ancestor) => ancestor.id).filter((id): id is string => !!id),
    page.id,
  ])];
  for (const contentId of contentIds) {
    const url = `${base.replace(/\/$/, "")}/rest/api/content/${encodeURIComponent(contentId)}`
      + "/restriction/byOperation/read?limit=1";
    try {
      const res = await fetch(url, { headers, signal });
      if (!res.ok) return false;
      const data = (await res.json()) as ConfluenceRestrictionResult;
      // Missing restriction collections are not proof of universal visibility.
      if (!data.restrictions?.user || !data.restrictions?.group) return false;
      if (restrictionCount(data) > 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function searchConfluence(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  const base = process.env.CONFLUENCE_BASE_URL;
  const token = process.env.CONFLUENCE_TOKEN;
  const email = process.env.CONFLUENCE_EMAIL ?? process.env.JIRA_EMAIL;
  if (!base || !token) {
    return { source: "confluence", documents: [], missing: "CONFLUENCE_BASE_URL or CONFLUENCE_TOKEN not set" };
  }
  if (opts.project_id && !["1", "true", "yes", "on"].includes(
    (process.env.PROJECT_CONFLUENCE_SEARCH_ENABLED ?? "").trim().toLowerCase(),
  )) {
    return { source: "confluence", documents: [], missing: "Confluence connector is disabled" };
  }
  try {
    if (process.env.NODE_ENV === "production" && new URL(base).protocol !== "https:") {
      return { source: "confluence", documents: [], missing: "Confluence connector requires HTTPS" };
    }
  } catch {
    return { source: "confluence", documents: [], missing: "Confluence base URL is invalid" };
  }

  const isCloud = (() => {
    try {
      return new URL(base).hostname.toLowerCase().endsWith(".atlassian.net") && !!email;
    } catch {
      return false;
    }
  })();
  const authHeader = isCloud
    ? "Basic " + Buffer.from(`${email}:${token}`).toString("base64")
    : `Bearer ${token}`;

  // On-prem Confluence rejects relative dates (`"-90d"`) — use an absolute
  // yyyy-MM-dd cutoff. Cloud accepts both, so this works for either flavor.
  const cutoff = new Date(Date.now() - opts.time_window_days * 864e5).toISOString().slice(0, 10);
  const clauses: string[] = [];
  const spaceKeys = opts.project_resources?.confluence?.space_keys ?? [];
  const pageIds = configuredPageIds(opts);
  if (opts.project_id && spaceKeys.length === 0 && pageIds.length === 0) {
    return {
      source: "confluence",
      documents: [],
      missing: "No Confluence spaces or pages are bound to this project",
    };
  }
  if (opts.project_id && !hasConfluenceProjectVisibilityPolicy()) {
    return {
      source: "confluence",
      documents: [],
      missing: "Confluence project visibility policy is not configured",
    };
  }
  const scopeClauses: string[] = [];
  if (spaceKeys.length > 0) {
    const list = spaceKeys.map((k) => `"${escapeCql(k)}"`).join(", ");
    scopeClauses.push(`space in (${list})`);
  }
  if (pageIds.length > 0) scopeClauses.push(`id in (${pageIds.map((id) => `"${escapeCql(id)}"`).join(", ")})`);
  if (scopeClauses.length > 0) clauses.push(`(${scopeClauses.join(" OR ")})`);
  clauses.push(`text ~ "${escapeCql(opts.query)}"`);
  clauses.push(`lastmodified >= "${cutoff}"`);
  const cql = clauses.join(" AND ");
  const url =
    `${base.replace(/\/$/, "")}/rest/api/content/search` +
    `?cql=${encodeURIComponent(cql)}` +
    `&limit=${opts.max_hits_per_source}` +
    `&expand=body.view,space,ancestors,history.lastUpdated,history.createdBy`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = { Authorization: authHeader, Accept: "application/json" };
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      return { source: "confluence", documents: [], missing: `Confluence request failed (${res.status})` };
    }

    const data = (await res.json()) as ConfluenceSearchResponse;
    const webBase = base.replace(/\/$/, "");
    const eligible = opts.project_id
      ? (await Promise.all((data.results ?? []).map(async (page) => ({
          page,
          visible: await isProjectVisible(base, page, headers, controller.signal),
        })))).filter((entry) => entry.visible).map((entry) => entry.page)
      : (data.results ?? []);
    const documents: SearchDocument[] = eligible.map((p) => ({
      org_id: opts.org_id,
      project_id: opts.project_id,
      source: "confluence",
      source_type: "page",
      source_id: p.id,
      source_url: p._links?.webui
        ? (() => {
            try { return new URL(p._links.webui, new URL(webBase).origin).toString(); }
            catch { return undefined; }
          })()
        : undefined,
      title: p.title ?? p.id,
      snippet: truncate(stripHtml(p.body?.view?.value ?? p.body?.storage?.value ?? "")),
      author: p.history?.createdBy?.displayName,
      timestamp: p.history?.lastUpdated?.when ?? p.history?.createdDate,
      metadata: { page_id: p.id, visibility: opts.project_id ? "project_visible" : "connector_visible" },
    }));

    return { source: "confluence", documents };
  } catch {
    return {
      source: "confluence",
      documents: [],
      missing: "Confluence connector request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
