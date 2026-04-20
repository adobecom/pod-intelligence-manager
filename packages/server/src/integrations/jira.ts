import type { ContextSearchHit } from "@council/shared";
import { type IntegrationResult, type IntegrationSearchOpts, truncate } from "./types.js";

// Jira search with JQL. Supports two Jira flavors:
//   - Adobe on-prem (jira.corp.adobe.com): Authorization: Bearer <PAT>, REST v2.
//   - Atlassian Cloud: Basic email:token base64, REST v3.
// Selects by presence of JIRA_EMAIL. The REST path also differs by flavor.

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    description?: string;
    status?: { name?: string };
    updated?: string;
    creator?: { displayName?: string; emailAddress?: string };
    assignee?: { displayName?: string };
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
}

function escapeJql(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Detect release-like tokens the user might have typed expecting a
// fixVersion filter: "T3-26.16", "v1.2.3", "sprint-42.1". Jira's text
// index doesn't tokenize hyphen/dot well, so `text ~ "T3-26.16"` returns
// nothing — but `fixVersion = "T3-26.16"` does. Extract these tokens,
// emit a fixVersion clause, and strip them from the text query.
function extractFixVersions(query: string): { versions: string[]; cleaned: string } {
  const re = /\b[A-Za-z][A-Za-z0-9]*-\d+(?:\.\d+)+\b/g;
  const versions = Array.from(new Set(Array.from(query.matchAll(re)).map((m) => m[0])));
  if (versions.length === 0) return { versions: [], cleaned: query };
  let cleaned = query;
  for (const v of versions) cleaned = cleaned.replace(v, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return { versions, cleaned };
}

function buildJql(opts: IntegrationSearchOpts): string {
  const clauses: string[] = [];

  const projectKeys = opts.project_resources?.jira?.project_keys ?? [];
  if (projectKeys.length > 0) {
    const keyList = projectKeys.map((k) => `"${escapeJql(k)}"`).join(", ");
    clauses.push(`project in (${keyList})`);
  }

  const team = opts.project_resources?.jira?.team;
  if (team) {
    clauses.push(`"Team" = "${escapeJql(team)}"`);
  }

  const actor = opts.actor;
  if (actor?.email) {
    const e = escapeJql(actor.email);
    clauses.push(`(assignee = "${e}" OR reporter = "${e}" OR creator = "${e}")`);
  }

  // When an actor was resolved, the authorship clause already captures the
  // person — the rest of the query ("what has X been up to") is natural
  // language, not a real text search term. Strip identifiers and common
  // activity phrasing before deciding whether any text-match is worth
  // adding on top of authorship.
  let textQuery = opts.query.trim();
  if (actor) {
    for (const t of [actor.email, actor.slack_user_id, actor.display_name]) {
      if (t) textQuery = textQuery.replace(t, "");
    }
    textQuery = textQuery
      .replace(/\bwhat\s+(has|have|is)\b/gi, "")
      .replace(/\bbeen\s+(up\s+to|doing|working\s+on)\b/gi, "")
      .replace(/\bworking\s+on\b/gi, "")
      .replace(/[?!.]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  // Pull release-like tokens out and emit them as a fixVersion filter —
  // the most common way people ask "what's in release X".
  const { versions, cleaned } = extractFixVersions(textQuery);
  if (versions.length > 0) {
    const vList = versions.map((v) => `"${escapeJql(v)}"`).join(", ");
    clauses.push(`fixVersion in (${vList})`);
    textQuery = cleaned;
  }

  if (textQuery && textQuery.length >= 3) {
    clauses.push(`text ~ "${escapeJql(textQuery)}"`);
  }

  // When filtering by fixVersion, the updated-window often excludes the
  // very tickets people want ("what's in 26.16" may include tickets last
  // touched 60+ days ago). fixVersion + project + team is already tight.
  if (versions.length === 0) {
    clauses.push(`updated >= -${opts.time_window_days}d`);
  }
  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

export async function searchJira(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  const base = process.env.JIRA_BASE_URL;
  const token = process.env.JIRA_TOKEN;
  const email = process.env.JIRA_EMAIL;
  if (!base || !token) {
    return { source: "jira", hits: [], missing: "JIRA_BASE_URL or JIRA_TOKEN not set" };
  }

  // Cloud tenants use `/rest/api/3` and Basic auth with email+token.
  // On-prem (e.g. jira.corp.adobe.com) uses `/rest/api/2` and Bearer PAT.
  const isCloud = /atlassian\.net$/i.test(base) && !!email;
  const restPath = isCloud ? "rest/api/3/search" : "rest/api/2/search";
  const authHeader = isCloud
    ? "Basic " + Buffer.from(`${email}:${token}`).toString("base64")
    : `Bearer ${token}`;

  const jql = buildJql(opts);

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/${restPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        Accept: "application/json",
      },
      body: JSON.stringify({
        jql,
        maxResults: opts.max_hits_per_source,
        fields: ["summary", "description", "status", "updated", "creator", "assignee"],
      }),
    });

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
      return { source: "jira", hits: [], missing: `Jira ${res.status}: ${body}` };
    }

    const data = (await res.json()) as JiraSearchResponse;
    const hits: ContextSearchHit[] = (data.issues ?? []).map((issue) => {
      const f = issue.fields ?? {};
      const descText =
        typeof f.description === "string"
          ? f.description
          : JSON.stringify(f.description ?? "").slice(0, 500);
      return {
        source: "jira",
        title: `${issue.key}: ${f.summary ?? ""}`,
        url: `${base.replace(/\/$/, "")}/browse/${issue.key}`,
        snippet: truncate(descText),
        author: f.creator?.displayName ?? f.creator?.emailAddress,
        timestamp: f.updated,
        metadata: {
          key: issue.key,
          status: f.status?.name,
          assignee: f.assignee?.displayName,
        },
      };
    });

    return { source: "jira", hits };
  } catch (err) {
    return {
      source: "jira",
      hits: [],
      missing: `Jira error: ${(err as Error).message}`,
    };
  }
}
