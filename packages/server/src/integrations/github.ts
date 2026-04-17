import type { ContextSearchHit } from "@pim/shared";
import { type IntegrationResult, type IntegrationSearchOpts, truncate } from "./types.js";

// GitHub REST search: /search/code + /search/issues. Scoped to GITHUB_SEARCH_ORGS.

interface CodeItem {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: { full_name?: string };
  text_matches?: Array<{ fragment?: string }>;
}

interface IssueItem {
  title?: string;
  html_url?: string;
  body?: string;
  user?: { login?: string };
  created_at?: string;
  updated_at?: string;
  state?: string;
  pull_request?: unknown;
}

interface SearchResponse<T> {
  items?: T[];
}

function orgScope(): string {
  const raw = process.env.GITHUB_SEARCH_ORGS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => `org:${o}`)
    .join(" ");
}

export async function searchGithub(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  const token = process.env.GH_TOKEN;
  if (!token) {
    return { source: "github", hits: [], missing: "GH_TOKEN not set" };
  }

  const scope = orgScope();
  if (!scope) {
    return { source: "github", hits: [], missing: "GITHUB_SEARCH_ORGS not set" };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.text-match+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const codeQuery = encodeURIComponent(`${opts.query} ${scope}`);
  const issueQuery = encodeURIComponent(
    `${opts.query} ${scope} updated:>=${new Date(Date.now() - opts.time_window_days * 864e5)
      .toISOString()
      .slice(0, 10)}`,
  );
  const perPage = Math.max(1, Math.ceil(opts.max_hits_per_source / 2));

  const [codeRes, issueRes] = await Promise.allSettled([
    fetch(`https://api.github.com/search/code?q=${codeQuery}&per_page=${perPage}`, { headers }),
    fetch(`https://api.github.com/search/issues?q=${issueQuery}&per_page=${perPage}`, { headers }),
  ]);

  const hits: ContextSearchHit[] = [];
  const errors: string[] = [];

  if (codeRes.status === "fulfilled" && codeRes.value.ok) {
    const data = (await codeRes.value.json()) as SearchResponse<CodeItem>;
    for (const item of data.items ?? []) {
      const fragment = item.text_matches?.[0]?.fragment ?? item.path ?? "";
      hits.push({
        source: "github",
        title: `${item.repository?.full_name ?? ""}/${item.path ?? item.name ?? ""}`,
        url: item.html_url,
        snippet: truncate(fragment),
        metadata: { kind: "code", repo: item.repository?.full_name },
      });
    }
  } else if (codeRes.status === "fulfilled") {
    errors.push(`code ${codeRes.value.status}`);
  } else {
    errors.push(`code ${codeRes.reason?.message ?? codeRes.reason}`);
  }

  if (issueRes.status === "fulfilled" && issueRes.value.ok) {
    const data = (await issueRes.value.json()) as SearchResponse<IssueItem>;
    for (const item of data.items ?? []) {
      hits.push({
        source: "github",
        title: `${item.pull_request ? "PR" : "Issue"}: ${item.title ?? ""}`,
        url: item.html_url,
        snippet: truncate(item.body ?? ""),
        author: item.user?.login,
        timestamp: item.updated_at ?? item.created_at,
        metadata: { kind: item.pull_request ? "pr" : "issue", state: item.state },
      });
    }
  } else if (issueRes.status === "fulfilled") {
    errors.push(`issues ${issueRes.value.status}`);
  } else {
    errors.push(`issues ${issueRes.reason?.message ?? issueRes.reason}`);
  }

  return {
    source: "github",
    hits: hits.slice(0, opts.max_hits_per_source),
    ...(errors.length && hits.length === 0 ? { missing: `GitHub: ${errors.join("; ")}` } : {}),
  };
}
