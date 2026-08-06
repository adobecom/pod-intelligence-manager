import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectResources, ProjectSourceHealthSource } from "@pim/shared";
import { redactProjectText, redactProjectUrl } from "./project-evidence-normalization.js";

export const CONNECTOR_RESOURCE_KEYS: readonly ProjectSourceHealthSource[] = [
  "github",
  "jira",
  "slack",
  "confluence",
  "git",
];

/** Canonical connector scopes selected by an org administrator and persisted
 * with the project. Service credentials remain deployment secrets, but their
 * non-secret resource scope has a single source of truth in resources_json. */
export function configuredGithubRepos(resources: ProjectResources): string[] {
  return [...new Set((resources.github?.repos ?? [])
    .map((repo) => repo.trim().toLowerCase()).filter(Boolean))].sort();
}

export function configuredJiraProjectKeys(resources: ProjectResources): string[] {
  const configured = [...new Set((resources.jira?.project_keys ?? [])
    .map((key) => key.trim().toUpperCase()).filter(Boolean))].sort();
  if (configured.length === 0) return [];
  const boundIssueKeys = [
    ...(resources.jira?.issue_keys ?? []),
    ...(resources.jira?.epics ?? []),
  ].map((key) => key.trim().toUpperCase()).filter(Boolean);
  if (boundIssueKeys.some((key) => !configured.some((projectKey) => key.startsWith(`${projectKey}-`)))) return [];
  return configured;
}

export function hasGithubProjectBinding(resources: ProjectResources): boolean {
  const configured = new Set((resources.github?.repos ?? [])
    .map((repo) => repo.trim().toLowerCase()).filter(Boolean)).size;
  return configured > 0 && configuredGithubRepos(resources).length === configured;
}

export function hasJiraProjectBinding(resources: ProjectResources): boolean {
  return configuredJiraProjectKeys(resources).length > 0;
}

function canonicalExistingPath(value: string): string | null {
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    return null;
  }
}

export function configuredProjectGitRoots(): string[] {
  const configured = process.env.PROJECT_GIT_ALLOWED_ROOTS?.trim();
  return [...new Set((configured || process.cwd())
    .split(",")
    .map((root) => canonicalExistingPath(root.trim()))
    .filter((root): root is string => !!root && root !== path.parse(root).root))]
    .sort();
}

/** Local repository reads are restricted to operator-owned roots. The default
 * is the server working tree; additional roots are comma-separated. */
export function isAllowedProjectGitPath(value: string): boolean {
  const candidate = canonicalExistingPath(value);
  if (!candidate) return false;
  return configuredProjectGitRoots()
    .some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

/** Stable comparison for JSON-compatible connector bindings. Array order is
 * not semantically meaningful for source scope, so it is canonicalized too. */
export function canonicalResourceValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalResourceValue).sort().join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalResourceValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sanitizeResourceValue(value: unknown, parentKey = ""): unknown {
  if (typeof value === "string") {
    return parentKey === "thread_urls" || parentKey === "page_urls"
      ? redactProjectUrl(value)
      : redactProjectText(value).text;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeResourceValue(item, parentKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, sanitizeResourceValue(child, key)]));
  }
  return value;
}

/** Resources are persisted, returned, and included in some model scope
 * payloads, so they cross the same canonical redaction boundary as evidence. */
export function sanitizeProjectResources(resources: ProjectResources): ProjectResources {
  return sanitizeResourceValue(resources) as ProjectResources;
}

export function changedConnectorSources(
  previous: ProjectResources,
  next: ProjectResources,
): ProjectSourceHealthSource[] {
  const safePrevious = sanitizeProjectResources(previous);
  const safeNext = sanitizeProjectResources(next);
  return CONNECTOR_RESOURCE_KEYS.filter((source) =>
    canonicalResourceValue(safePrevious[source]) !== canonicalResourceValue(safeNext[source]));
}

export function connectorBindingVersion(
  resources: ProjectResources,
  source: ProjectSourceHealthSource,
): string | null {
  resources = sanitizeProjectResources(resources);
  const gitPaths = resources.git?.repo_paths ?? [];
  const configured = source === "github"
    ? hasGithubProjectBinding(resources)
    : source === "jira"
      ? hasJiraProjectBinding(resources)
      : source === "slack"
        ? (resources.slack?.channels?.length ?? 0) > 0
        : source === "confluence"
          ? (resources.confluence?.space_keys?.length ?? 0)
            + (resources.confluence?.page_ids?.length ?? 0)
            + (resources.confluence?.page_urls?.length ?? 0) > 0
          : gitPaths.length > 0 && gitPaths.every(isAllowedProjectGitPath);
  if (!configured) return null;
  const endpointIdentity = source === "jira"
    ? (process.env.JIRA_BASE_URL ?? "").trim().replace(/\/+$/, "")
    : source === "confluence"
      ? process.env.CONFLUENCE_BASE_URL ?? ""
      : source === "github"
        ? "https://api.github.com"
        : source === "git"
          ? canonicalResourceValue(configuredProjectGitRoots())
          : "";
  const digest = crypto
    .createHash("sha256")
    .update(`${source}\0${canonicalResourceValue(resources[source])}\0${endpointIdentity}`)
    .digest("hex");
  return `resource-binding-v1:${digest}`;
}

export interface ProjectResourceEligibilitySql {
  sql: string;
  params: string[];
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function pageIds(resources: ProjectResources): string[] {
  const values = new Set((resources.confluence?.page_ids ?? []).map(String).map((id) => id.trim()).filter(Boolean));
  for (const raw of resources.confluence?.page_urls ?? []) {
    try {
      const url = new URL(raw);
      const match = url.pathname.match(/\/pages\/(\d+)/i) ?? url.search.match(/[?&]pageId=(\d+)/i);
      if (match?.[1]) values.add(match[1]);
    } catch {
      // Invalid URL bindings never widen the SQL predicate.
    }
  }
  return [...values].sort();
}

/** Current project-resource boundary for both evidence and indexed documents.
 * Every connector branch requires an opaque version of the full binding plus
 * the strongest item-level predicate available from allowlisted metadata. */
export function projectResourceEligibilitySql(
  alias: string,
  resources: ProjectResources,
): ProjectResourceEligibilitySql {
  const safeMetadata = `CASE WHEN json_valid(${alias}.metadata_json) THEN ${alias}.metadata_json ELSE '{}' END`;
  const branches: string[] = [
    `${alias}.source NOT IN ('github', 'jira', 'slack', 'confluence', 'git', 'commit')`,
  ];
  const params: string[] = [];

  const addBranch = (
    sources: string[],
    source: ProjectSourceHealthSource,
    itemSql: string,
    itemParams: string[],
  ) => {
    const version = connectorBindingVersion(resources, source);
    if (!version) return;
    branches.push(
      `(${alias}.source IN (${sources.map((value) => `'${value}'`).join(", ")})`
      + ` AND CAST(json_extract(${safeMetadata}, '$.resource_binding_version') AS TEXT) = ?`
      + ` AND (${itemSql}))`,
    );
    params.push(version, ...itemParams);
  };

  const repos = configuredGithubRepos(resources);
  if (repos.length > 0) {
    const repoTerms = repos.map(() =>
      `(lower(CAST(json_extract(${safeMetadata}, '$.repo') AS TEXT)) = ?`
      + ` OR lower(${alias}.source_id) LIKE ? OR lower(${alias}.source_id) LIKE ?)`);
    addBranch(
      ["github"],
      "github",
      repoTerms.join(" OR "),
      repos.flatMap((repo) => [repo, `${repo}#%`, `${repo}@%`]),
    );
  }

  const projectKeys = configuredJiraProjectKeys(resources);
  const issueKeys = projectKeys.length > 0
    ? [...new Set((resources.jira?.issue_keys ?? [])
        .map((key) => key.trim().toUpperCase()).filter(Boolean))].sort()
    : [];
  const epics = projectKeys.length > 0
    ? [...new Set((resources.jira?.epics ?? [])
        .map((key) => key.trim().toUpperCase()).filter(Boolean))].sort()
    : [];
  const jiraTerms: string[] = [];
  const jiraParams: string[] = [];
  const projectTerms: string[] = [];
  const projectParams: string[] = [];
  const releaseTerms: string[] = [];
  const releaseParams: string[] = [];
  for (const key of projectKeys) {
    projectTerms.push(
      `(upper(${alias}.source_id) LIKE ?`
      + ` OR upper(CAST(json_extract(${safeMetadata}, '$.project_key') AS TEXT)) = ?)`,
    );
    projectParams.push(`${key}-%`, key);
    releaseTerms.push(`upper(${alias}.source_id) LIKE ?`);
    releaseParams.push(`RELEASE:${key}:%`);
  }
  if (projectTerms.length > 0) {
    jiraTerms.push(`(upper(${alias}.source_id) NOT LIKE 'RELEASE:%' AND (${projectTerms.join(" OR ")}))`);
    jiraParams.push(...projectParams);
  }
  if (issueKeys.length > 0) {
    jiraTerms.push(
      `upper(${alias}.source_id) IN (${placeholders(issueKeys)})`,
    );
    jiraParams.push(...issueKeys);
  }
  if (epics.length > 0) {
    jiraTerms.push(
      `(upper(${alias}.source_id) IN (${placeholders(epics)})`
      + ` OR upper(CAST(json_extract(${safeMetadata}, '$.parent') AS TEXT)) IN (${placeholders(epics)}))`,
    );
    jiraParams.push(...epics, ...epics);
  }
  for (const [field, values] of [
    ["components", resources.jira?.components ?? []],
    ["fix_versions", resources.jira?.fix_versions ?? []],
  ] as const) {
    const normalized = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
    if (normalized.length === 0) continue;
    jiraTerms.push(
      `EXISTS (SELECT 1 FROM json_each(${safeMetadata}, '$.${field}') binding_value`
      + ` WHERE lower(CAST(binding_value.value AS TEXT)) IN (${placeholders(normalized)}))`,
    );
    jiraParams.push(...normalized);
  }
  // Jira issue fields are narrowing dimensions, matching buildPollJql's
  // conjunctive JQL. Releases are a separate project-key/version-prefix poll
  // and intentionally do not inherit issue-only component/epic/key filters.
  // Team is covered by the opaque binding version because the current issue
  // projection does not persist Jira's vendor-specific Team field.
  const jiraItemTerms: string[] = [];
  const jiraItemParams: string[] = [];
  if (releaseTerms.length > 0) {
    jiraItemTerms.push(`(${releaseTerms.join(" OR ")})`);
    jiraItemParams.push(...releaseParams);
  }
  if (jiraTerms.length > 0) {
    jiraItemTerms.push(`(${jiraTerms.join(" AND ")})`);
    jiraItemParams.push(...jiraParams);
  }
  addBranch(["jira"], "jira", jiraItemTerms.join(" OR ") || "0 = 1", jiraItemParams);

  const slackTerms: string[] = [];
  const slackParams: string[] = [];
  for (const raw of resources.slack?.channels ?? []) {
    const parts = raw.trim().split(":");
    const channelId = parts.at(-1)?.trim();
    if (!channelId) continue;
    // The optional prefix is a credential/workspace selector and may not be
    // Slack's native team id. The opaque binding version covers that selector;
    // the item-level predicate uses the canonical channel id.
    slackTerms.push(`CAST(json_extract(${safeMetadata}, '$.channel_id') AS TEXT) = ?`);
    slackParams.push(channelId);
  }
  const threadUrls = [...new Set((resources.slack?.thread_urls ?? []).map((url) => url.trim()).filter(Boolean))].sort();
  if (threadUrls.length > 0) {
    slackTerms.push(`${alias}.source_url IN (${placeholders(threadUrls)})`);
    slackParams.push(...threadUrls);
  }
  addBranch(["slack"], "slack", slackTerms.join(" OR ") || "0 = 1", slackParams);

  const spaces = [...new Set((resources.confluence?.space_keys ?? []).map((key) => key.trim().toUpperCase()).filter(Boolean))].sort();
  const pages = pageIds(resources);
  const confluenceTerms: string[] = [];
  const confluenceParams: string[] = [];
  if (spaces.length > 0) {
    confluenceTerms.push(
      `upper(CAST(json_extract(${safeMetadata}, '$.space_key') AS TEXT)) IN (${placeholders(spaces)})`,
    );
    confluenceParams.push(...spaces);
  }
  if (pages.length > 0) {
    confluenceTerms.push(
      `CAST(json_extract(${safeMetadata}, '$.page_id') AS TEXT) IN (${placeholders(pages)})`,
    );
    confluenceParams.push(...pages);
  }
  addBranch(["confluence"], "confluence", confluenceTerms.join(" OR ") || "0 = 1", confluenceParams);

  addBranch(
    ["git", "commit"],
    "git",
    // Git resolves configured subdirectories/symlinks to a canonical repo root
    // at index time. The binding fingerprint is the exact current allowlist.
    "1 = 1",
    [],
  );

  return { sql: `(${branches.join(" OR ")})`, params };
}
