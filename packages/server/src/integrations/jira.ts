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

  const jql = `text ~ "${escapeJql(opts.query)}" AND updated >= -${opts.time_window_days}d ORDER BY updated DESC`;

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
