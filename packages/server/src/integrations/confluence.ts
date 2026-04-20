import type { ContextSearchHit } from "@pim/shared";
import { type IntegrationResult, type IntegrationSearchOpts, truncate } from "./types.js";

// Atlassian Confluence REST /content/search with CQL. Supports two flavors:
//   - Adobe on-prem (wiki.corp.adobe.com): Authorization: Bearer <PAT>.
//   - Atlassian Cloud: Basic email:token base64.
// Selects by hostname + presence of an email.

interface ConfluencePage {
  id: string;
  title?: string;
  _links?: { webui?: string };
  history?: { createdBy?: { displayName?: string }; createdDate?: string; lastUpdated?: { when?: string } };
  body?: { view?: { value?: string }; storage?: { value?: string } };
}

interface ConfluenceSearchResponse {
  results?: ConfluencePage[];
}

function escapeCql(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
}

export async function searchConfluence(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  const base = process.env.CONFLUENCE_BASE_URL;
  const token = process.env.CONFLUENCE_TOKEN;
  const email = process.env.CONFLUENCE_EMAIL ?? process.env.JIRA_EMAIL;
  if (!base || !token) {
    return { source: "confluence", hits: [], missing: "CONFLUENCE_BASE_URL or CONFLUENCE_TOKEN not set" };
  }

  const isCloud = /atlassian\.net$/i.test(base) && !!email;
  const authHeader = isCloud
    ? "Basic " + Buffer.from(`${email}:${token}`).toString("base64")
    : `Bearer ${token}`;

  // On-prem Confluence rejects relative dates (`"-90d"`) — use an absolute
  // yyyy-MM-dd cutoff. Cloud accepts both, so this works for either flavor.
  const cutoff = new Date(Date.now() - opts.time_window_days * 864e5).toISOString().slice(0, 10);
  const clauses: string[] = [];
  const spaceKeys = opts.project_resources?.confluence?.space_keys ?? [];
  if (spaceKeys.length > 0) {
    const list = spaceKeys.map((k) => `"${escapeCql(k)}"`).join(", ");
    clauses.push(`space in (${list})`);
  }
  clauses.push(`text ~ "${escapeCql(opts.query)}"`);
  clauses.push(`lastmodified >= "${cutoff}"`);
  const cql = clauses.join(" AND ");
  const url =
    `${base.replace(/\/$/, "")}/rest/api/content/search` +
    `?cql=${encodeURIComponent(cql)}` +
    `&limit=${opts.max_hits_per_source}` +
    `&expand=body.view,history.lastUpdated,history.createdBy`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: authHeader, Accept: "application/json" },
    });

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
      return { source: "confluence", hits: [], missing: `Confluence ${res.status}: ${body}` };
    }

    const data = (await res.json()) as ConfluenceSearchResponse;
    const hits: ContextSearchHit[] = (data.results ?? []).map((p) => ({
      source: "confluence",
      title: p.title ?? p.id,
      url: p._links?.webui ? `${base.replace(/\/$/, "")}${p._links.webui}` : undefined,
      snippet: truncate(stripHtml(p.body?.view?.value ?? p.body?.storage?.value ?? "")),
      author: p.history?.createdBy?.displayName,
      timestamp: p.history?.lastUpdated?.when ?? p.history?.createdDate,
      metadata: { page_id: p.id },
    }));

    return { source: "confluence", hits };
  } catch (err) {
    return {
      source: "confluence",
      hits: [],
      missing: `Confluence error: ${(err as Error).message}`,
    };
  }
}
