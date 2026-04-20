import type { ContextSearchActor, ContextSearchHit } from "@council/shared";
import { type IntegrationResult, type IntegrationSearchOpts, truncate } from "./types.js";

function stripPersonTokens(query: string, actor?: ContextSearchActor): string {
  if (!actor) return query;
  let q = query;
  for (const token of [actor.email, actor.slack_user_id]) {
    if (token) q = q.replace(token, "");
  }
  return q.replace(/\s+/g, " ").trim();
}

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

function repoScope(opts: IntegrationSearchOpts): string {
  const repos = opts.project_resources?.github?.repos ?? [];
  return repos.map((r) => `repo:${r}`).join(" ");
}

export async function searchGithub(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  const token = process.env.GH_TOKEN;
  if (!token) {
    return { source: "github", hits: [], missing: "GH_TOKEN not set" };
  }

  // Prefer project-configured repos over the env org scope. If neither is
  // set we can still search by actor (author:X), so only bail when nothing
  // narrows the search at all.
  const scope = repoScope(opts) || orgScope();
  if (!scope && !opts.actor?.github_login) {
    return {
      source: "github",
      hits: [],
      missing:
        "No scope: configure GITHUB_SEARCH_ORGS, add repos to the project, or pass an actor",
    };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.text-match+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const login = opts.actor?.github_login;
  const codeActor = login ? `author:${login}` : "";
  const issueActor = login ? `involves:${login}` : "";

  // Strip person tokens from the text query when they're already encoded
  // as author: / involves: qualifiers.
  const cleanedQuery = stripPersonTokens(opts.query, opts.actor);

  const codeQuery = encodeURIComponent(
    [cleanedQuery, scope, codeActor].filter(Boolean).join(" ").trim(),
  );
  // GitHub's /search/issues endpoint now rejects queries without an
  // `is:issue` or `is:pr` qualifier (HTTP 422). Fire both in parallel
  // and merge — PRs usually give better signal, but issues matter too.
  const updatedClause = `updated:>=${new Date(Date.now() - opts.time_window_days * 864e5).toISOString().slice(0, 10)}`;
  const baseIssueTerms = [cleanedQuery, scope, issueActor, updatedClause]
    .filter(Boolean)
    .join(" ")
    .trim();
  const prQuery = encodeURIComponent(`${baseIssueTerms} is:pr`);
  const issueQuery = encodeURIComponent(`${baseIssueTerms} is:issue`);
  const perPage = Math.max(1, Math.ceil(opts.max_hits_per_source / 3));

  const codeUrl = `https://api.github.com/search/code?q=${codeQuery}&per_page=${perPage}`;
  const prUrl = `https://api.github.com/search/issues?q=${prQuery}&per_page=${perPage}`;
  const issueUrl = `https://api.github.com/search/issues?q=${issueQuery}&per_page=${perPage}`;

  const [codeRes, prRes, issueRes] = await Promise.allSettled([
    fetch(codeUrl, { headers }),
    fetch(prUrl, { headers }),
    fetch(issueUrl, { headers }),
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
    const body = (await codeRes.value.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
    errors.push(`code ${codeRes.value.status}: ${body}`);
  } else {
    errors.push(`code ${codeRes.reason?.message ?? codeRes.reason}`);
  }

  async function collectIssues(
    res: PromiseSettledResult<Response>,
    label: "prs" | "issues",
  ): Promise<void> {
    if (res.status === "fulfilled" && res.value.ok) {
      const data = (await res.value.json()) as SearchResponse<IssueItem>;
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
    } else if (res.status === "fulfilled") {
      const body = (await res.value.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
      errors.push(`${label} ${res.value.status}: ${body}`);
    } else {
      errors.push(`${label} ${res.reason?.message ?? res.reason}`);
    }
  }
  await Promise.all([collectIssues(prRes, "prs"), collectIssues(issueRes, "issues")]);

  return {
    source: "github",
    hits: hits.slice(0, opts.max_hits_per_source),
    ...(errors.length && hits.length === 0 ? { missing: `GitHub: ${errors.join("; ")}` } : {}),
  };
}
