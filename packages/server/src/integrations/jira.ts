import type { SearchDocument } from "@pim/shared";
import {
  type IntegrationResult,
  type IntegrationSearchOpts,
  truncate,
} from "./types.js";
import { hasJiraProjectVisibilityPolicy } from "../services/project-resource-bindings.js";

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
//
// Exported because the context-search orchestrator also uses this to
// decide whether the IMS-authenticated-user fallback should activate:
// a fixVersion token is already a sufficient narrowing dimension for
// Jira, so a release query like "what's in T3-26.16" must not be
// silently narrowed to the caller as actor (that would drop teammates'
// results from the same release).
export function extractFixVersions(query: string): { versions: string[]; cleaned: string } {
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
  const jira = opts.project_resources?.jira;

  const projectKeys = jira?.project_keys ?? [];
  if (projectKeys.length > 0) {
    const keyList = projectKeys.map((k) => `"${escapeJql(k)}"`).join(", ");
    clauses.push(`project in (${keyList})`);
  }

  const team = jira?.team;
  if (team) {
    clauses.push(`"Team" = "${escapeJql(team)}"`);
  }

  const components = jira?.components ?? [];
  if (components.length > 0) {
    clauses.push(`component in (${components.map((value) => `"${escapeJql(value)}"`).join(", ")})`);
  }

  const epics = jira?.epics ?? [];
  if (epics.length > 0) {
    const list = epics.map((value) => `"${escapeJql(value)}"`).join(", ");
    clauses.push(`("Epic Link" in (${list}) OR parent in (${list}))`);
  }

  const issueKeys = jira?.issue_keys ?? [];
  if (issueKeys.length > 0) {
    clauses.push(`issuekey in (${issueKeys.map((value) => `"${escapeJql(value)}"`).join(", ")})`);
  }

  const configuredFixVersions = jira?.fix_versions ?? [];
  if (configuredFixVersions.length > 0) {
    clauses.push(`fixVersion in (${configuredFixVersions.map((value) => `"${escapeJql(value)}"`).join(", ")})`);
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
    return { source: "jira", documents: [], missing: "JIRA_BASE_URL or JIRA_TOKEN not set" };
  }

  // Fail-closed scope guard. Unscoped full-text JQL against the shared
  // Adobe Jira instance (~35K users) is one of the most expensive queries
  // the API will run; refuse it. Allow Jira only when at least one
  // narrowing dimension is present: project keys, a Jira "Team" custom-
  // field value, an actor filter, or a release-version token in the
  // query. Each of these makes buildJql() emit a narrowing clause; the
  // guard mirrors that exact set so no valid onboarded configuration is
  // refused.
  const projectKeys = opts.project_resources?.jira?.project_keys ?? [];
  const team = opts.project_resources?.jira?.team;
  if (opts.project_id && projectKeys.length === 0 && !team) {
    return { source: "jira", documents: [], missing: "No Jira project or team is bound to this project" };
  }
  if (opts.project_id && opts.project_resources && !hasJiraProjectVisibilityPolicy(opts.project_resources)) {
    return { source: "jira", documents: [], missing: "Jira project visibility policy is not configured" };
  }
  const hasActor = !!opts.actor?.email;
  const { versions } = extractFixVersions(opts.query);
  const hasNarrowingScope =
    projectKeys.length > 0 || !!team || hasActor || versions.length > 0;
  if (!hasNarrowingScope) {
    return {
      source: "jira",
      documents: [],
      missing:
        "Jira search refused: no project scope, team, actor, or release version. " +
        "Configure project_resources.jira.project_keys or project_resources.jira.team " +
        "via configure_project_resources, pass an explicit project_id, sign in (IMS) " +
        "so the server can scope to your identity, or include a fixVersion token " +
        "(e.g. T3-26.16) in the query.",
    };
  }

  // Cloud tenants use `/rest/api/3` and Basic auth with email+token.
  // On-prem (e.g. jira.corp.adobe.com) uses `/rest/api/2` and Bearer PAT.
  const isCloud = /atlassian\.net$/i.test(base) && !!email;
  const restPath = isCloud ? "rest/api/3/search" : "rest/api/2/search";
  const authHeader = isCloud
    ? "Basic " + Buffer.from(`${email}:${token}`).toString("base64")
    : `Bearer ${token}`;

  const jql = buildJql(opts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
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
      signal: controller.signal,
    });

    if (!res.ok) {
      return { source: "jira", documents: [], missing: `Jira request failed (${res.status})` };
    }

    const data = (await res.json()) as JiraSearchResponse;
    const documents: SearchDocument[] = (data.issues ?? []).map((issue) => {
      const f = issue.fields ?? {};
      const descText =
        typeof f.description === "string"
          ? f.description
          : JSON.stringify(f.description ?? "").slice(0, 500);
      return {
        org_id: opts.org_id,
        project_id: opts.project_id,
        source: "jira",
        source_type: "issue",
        source_id: issue.key,
        source_url: `${base.replace(/\/$/, "")}/browse/${issue.key}`,
        title: `${issue.key}: ${f.summary ?? ""}`,
        snippet: truncate(descText),
        author: f.creator?.displayName ?? f.creator?.emailAddress,
        timestamp: f.updated,
        status: f.status?.name,
        metadata: {
          key: issue.key,
          status: f.status?.name,
          assignee: f.assignee?.displayName,
        },
      };
    });

    return { source: "jira", documents };
  } catch {
    return {
      source: "jira",
      documents: [],
      missing: "Jira connector request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
