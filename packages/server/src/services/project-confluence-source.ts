import crypto from "node:crypto";
import type { ProjectResources, ProjectSourceCapabilities, ProjectSourceChange } from "@pim/shared";
import db from "../db/connection.js";
import {
  hasConfluenceProjectVisibilityPolicy,
  isConfluenceCandidateProjectVisible,
} from "../integrations/confluence-visibility.js";
import {
  applySourceChanges,
  purgeProjectEvidenceSource,
  recordProjectSourceReconciliation,
  recordProjectSourceSyncAttempt,
  recordProjectSourceSyncFailure,
  recordProjectSourceSyncSuccess,
} from "./project-source-change.js";
import { normalizeProjectEvidence } from "./project-evidence-normalization.js";
import { connectorBindingVersion } from "./project-resource-bindings.js";

const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_MAX_PAGES = 5_000;
const DEFAULT_RETRY_ATTEMPTS = 3;

export const CONFLUENCE_SOURCE_CAPABILITIES: ProjectSourceCapabilities = {
  pagination: "server_next_url",
  overlap_window: false,
  deletion_reconciliation: true,
  source_versions: true,
  visibility: "project_visible_only",
};

interface ConfluenceIdentity {
  base: URL;
  sourceInstance: string;
  authorization: string;
}

interface ConfluencePage {
  id: string;
  type?: string;
  status?: string;
  title?: string;
  space?: { id?: string | number; key?: string; name?: string };
  version?: { number?: number; when?: string; by?: { displayName?: string } };
  history?: {
    createdDate?: string;
    createdBy?: { displayName?: string };
    lastUpdated?: { when?: string; number?: number; by?: { displayName?: string } };
  };
  body?: { storage?: { value?: string }; view?: { value?: string } };
  ancestors?: Array<{ id?: string }>;
  _links?: { webui?: string; self?: string };
}

interface ConfluenceSearchPage {
  results?: ConfluencePage[];
  size?: number;
  _links?: { next?: string };
}

interface ConfluenceRestrictionResult {
  restrictions?: {
    user?: { size?: number; totalSize?: number; results?: unknown[] };
    group?: { size?: number; totalSize?: number; results?: unknown[] };
  };
}

export interface ConfluenceSection {
  key: string;
  heading: string;
  headingPath: string[];
  body: string;
  anchor?: string;
}

export interface ConfluencePollResult {
  source_instance: string;
  changes: ProjectSourceChange[];
  /** Every page whose visibility was evaluated during a complete scan. */
  seen_page_ids: string[];
  /** Pages that were present but not universally project-visible. */
  ineligible_page_ids: string[];
  complete: boolean;
  newest_updated_at?: string;
  pages_scanned: number;
  pages_admitted: number;
  missing?: string;
}

export interface ConfluenceProjectSyncResult {
  source: "confluence";
  ingested: number;
  deleted: number;
  quarantined: number;
  missing?: string;
}

export interface ConfluencePollDependencies {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxPages?: number;
  pageLimit?: number;
  retryAttempts?: number;
  requestTimeoutMs?: number;
}

type ConfluenceFetchDependencies = Required<Pick<
  ConfluencePollDependencies,
  "fetch" | "sleep" | "retryAttempts" | "requestTimeoutMs"
>>;

function escapeCql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function configuredPageIds(resources: ProjectResources): string[] {
  const ids = new Set((resources.confluence?.page_ids ?? []).map((id) => id.trim()).filter(Boolean));
  for (const raw of resources.confluence?.page_urls ?? []) {
    try {
      const url = new URL(raw);
      const match = url.pathname.match(/\/pages\/(\d+)/i) ?? url.search.match(/[?&]pageId=(\d+)/i);
      if (match?.[1]) ids.add(match[1]);
    } catch {
      // Invalid bindings are ignored; an all-invalid scope remains fail-closed.
    }
  }
  return [...ids];
}

export function buildConfluenceScopeCql(resources: ProjectResources): string | null {
  const spaces = (resources.confluence?.space_keys ?? []).map((key) => key.trim()).filter(Boolean);
  const pageIds = configuredPageIds(resources);
  const scopes: string[] = [];
  if (spaces.length > 0) scopes.push(`space in (${spaces.map((key) => `"${escapeCql(key)}"`).join(", ")})`);
  if (pageIds.length > 0) scopes.push(`id in (${pageIds.map((id) => `"${escapeCql(id)}"`).join(", ")})`);
  if (scopes.length === 0) return null;
  return `type = page AND (${scopes.join(" OR ")}) ORDER BY lastmodified ASC`;
}

function confluenceIdentity(): ConfluenceIdentity | null {
  const rawBase = process.env.CONFLUENCE_BASE_URL;
  const token = process.env.CONFLUENCE_TOKEN;
  if (!rawBase || !token) return null;
  let base: URL;
  try {
    base = new URL(rawBase.endsWith("/") ? rawBase : `${rawBase}/`);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && process.env.NODE_ENV === "production") return null;
  const email = process.env.CONFLUENCE_EMAIL ?? process.env.JIRA_EMAIL;
  const cloud = base.hostname.toLowerCase().endsWith(".atlassian.net") && !!email;
  return {
    base,
    sourceInstance: `${base.host}${base.pathname.replace(/\/$/, "")}`,
    authorization: cloud
      ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
      : `Bearer ${token}`,
  };
}

function apiUrl(identity: ConfluenceIdentity, suffix: string): URL {
  const prefix = identity.base.pathname.replace(/\/$/, "");
  const url = new URL(identity.base.origin);
  url.pathname = `${prefix}${suffix}`.replace(/\/{2,}/g, "/");
  return url;
}

/** Accept only the connector endpoint on the configured site before forwarding
 * credentials to a server-provided pagination URL. */
export function validateConfluenceNextUrl(identityBase: string, rawNext: string): URL | null {
  try {
    const base = new URL(identityBase.endsWith("/") ? identityBase : `${identityBase}/`);
    const next = new URL(rawNext, base);
    const prefix = `${base.pathname.replace(/\/$/, "")}/rest/api/content/search`.replace(/\/{2,}/g, "/");
    if (next.origin !== base.origin || next.pathname !== prefix) return null;
    return next;
  } catch {
    return null;
  }
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 1_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? 1_000 : Math.max(0, Math.min(date - Date.now(), 60_000));
}

async function fetchJson<T>(
  url: URL,
  identity: ConfluenceIdentity,
  deps: ConfluenceFetchDependencies,
): Promise<T> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < deps.retryAttempts; attempt++) {
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deps.requestTimeoutMs);
    try {
      response = await deps.fetch(url, {
        headers: { Authorization: identity.authorization, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      throw new Error("confluence_fetch_failed");
    } finally {
      clearTimeout(timeout);
    }
    lastStatus = response.status;
    if (response.ok) {
      try {
        return await response.json() as T;
      } catch {
        // JSON parser messages can contain snippets of the upstream body.
        throw new Error("confluence_invalid_json");
      }
    }
    if (response.status !== 429 && response.status < 500) break;
    if (attempt + 1 < deps.retryAttempts) await deps.sleep(retryAfterMs(response));
  }
  // Do not include raw upstream bodies in operational errors.
  throw new Error(`confluence_http_${lastStatus || "failure"}`);
}

function restrictionCount(value: ConfluenceRestrictionResult): number | null {
  const user = value.restrictions?.user;
  const group = value.restrictions?.group;
  if (!user || !group) return null;
  const count = (entry: typeof user) => entry.totalSize ?? entry.size ?? entry.results?.length ?? 0;
  return count(user) + count(group);
}

async function visibilityForPage(
  identity: ConfluenceIdentity,
  page: ConfluencePage,
  deps: ConfluenceFetchDependencies,
): Promise<"project_visible" | "restricted" | "unknown"> {
  if (!isConfluenceCandidateProjectVisible(page)) return "unknown";
  // The request asks Confluence to expand ancestors. Omission is not proof
  // that the page has no inherited read restriction; a root page is `[]`.
  if (!Array.isArray(page.ancestors)) return "unknown";
  const contentIds = [...new Set([
    ...(page.ancestors ?? []).map((ancestor) => ancestor.id).filter((id): id is string => !!id),
    page.id,
  ])];
  for (const contentId of contentIds) {
    const url = apiUrl(identity, `/rest/api/content/${encodeURIComponent(contentId)}/restriction/byOperation/read`);
    url.searchParams.set("limit", "1");
    try {
      const result = await fetchJson<ConfluenceRestrictionResult>(url, identity, deps);
      const count = restrictionCount(result);
      if (count === null) return "unknown";
      if (count > 0) return "restricted";
    } catch {
      return "unknown";
    }
  }
  return "project_visible";
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function htmlToText(value: string): string {
  return decodeHtml(value)
    .replace(/<(?:br\s*\/?|\/p|\/div|\/li|\/tr|\/h[1-6])>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sectionKey(path: string[], occurrence: number): string {
  const slug = path.join("-")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "overview";
  return `${slug}-${occurrence}`;
}

/** Split Confluence storage HTML on heading hierarchy. Stable keys are based on
 * the heading path plus an occurrence counter; edits retain their native ID. */
export function splitConfluenceSections(html: string): ConfluenceSection[] {
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  if (headings.length === 0) {
    const body = htmlToText(html);
    return body ? [{ key: "overview-1", heading: "Overview", headingPath: ["Overview"], body }] : [];
  }

  const sections: ConfluenceSection[] = [];
  const hierarchy: string[] = [];
  const occurrences = new Map<string, number>();
  const intro = htmlToText(html.slice(0, headings[0].index ?? 0));
  if (intro) sections.push({ key: "overview-1", heading: "Overview", headingPath: ["Overview"], body: intro });

  headings.forEach((match, index) => {
    const level = Number(match[1]);
    const heading = htmlToText(match[2]).trim() || "Untitled";
    hierarchy.length = Math.max(0, level - 1);
    hierarchy[level - 1] = heading;
    const path = hierarchy.filter(Boolean);
    const occurrenceKey = path.join("\0").toLowerCase();
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = index + 1 < headings.length ? (headings[index + 1].index ?? html.length) : html.length;
    const body = htmlToText(html.slice(bodyStart, bodyEnd));
    sections.push({
      key: sectionKey(path, occurrence),
      heading,
      headingPath: path,
      body: body || heading,
      anchor: sectionKey([heading], 1).replace(/-1$/, ""),
    });
  });
  return sections;
}

function absoluteWebUrl(identity: ConfluenceIdentity, raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, identity.base.origin).toString();
  } catch {
    return undefined;
  }
}

function firstSentence(text: string, fallback: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return fallback;
  const end = clean.search(/[.!?](?:\s|$)/);
  return clean.slice(0, end >= 0 ? end + 1 : 280);
}

function pageUpdatedAt(page: ConfluencePage): string | undefined {
  return page.version?.when ?? page.history?.lastUpdated?.when ?? page.history?.createdDate;
}

function pageVersion(page: ConfluencePage): string {
  return String(page.version?.number ?? page.history?.lastUpdated?.number ?? pageUpdatedAt(page) ?? "unknown");
}

function sectionChanges(
  orgId: string,
  projectId: string,
  identity: ConfluenceIdentity,
  page: ConfluencePage,
  sections: ConfluenceSection[],
  resourceBindingVersion: string | null,
): ProjectSourceChange[] {
  const version = pageVersion(page);
  const updatedAt = pageUpdatedAt(page);
  const pageTitle = page.title?.trim() || page.id;
  const pageUrl = absoluteWebUrl(identity, page._links?.webui);
  const nativeIds = sections.map((section) => `${page.id}:section:${section.key}`);
  return sections.map((section, index) => {
    const nativeId = nativeIds[index];
    const normalized = normalizeProjectEvidence({
      source: "confluence",
      source_type: "page_section",
      source_id: `${identity.sourceInstance}::${nativeId}`,
      source_instance: identity.sourceInstance,
      native_id: nativeId,
      ...(pageUrl ? { source_url: section.anchor ? `${pageUrl}#${encodeURIComponent(section.anchor)}` : pageUrl } : {}),
      source_title: `${pageTitle} — ${section.heading}`,
      summary: firstSentence(section.body, `${pageTitle}: ${section.heading}`),
      body: section.body,
      author: page.version?.by?.displayName
        ?? page.history?.lastUpdated?.by?.displayName
        ?? page.history?.createdBy?.displayName,
      metadata: {
        resource_binding_version: resourceBindingVersion,
        site_id: identity.sourceInstance,
        page_id: page.id,
        page_title: pageTitle,
        space_key: page.space?.key,
        page_version: version,
        section_index: index,
        section_count: sections.length,
        heading: section.heading,
        heading_path: section.headingPath,
        anchor: section.anchor,
        previous_native_id: index > 0 ? nativeIds[index - 1] : undefined,
        next_native_id: index + 1 < nativeIds.length ? nativeIds[index + 1] : undefined,
        visibility: "project_visible",
        binding_key: page.space?.key ? `space:${page.space.key}` : `page:${page.id}`,
      },
      visibility: "project_visible",
      visibility_version: `${version}:unrestricted-read`,
      source_updated_at: updatedAt,
    });
    return {
      kind: "upsert",
      org_id: orgId,
      project_id: projectId,
      source: "confluence",
      source_instance: identity.sourceInstance,
      native_id: nativeId,
      source_version: `${version}:${crypto.createHash("sha256").update(section.body).digest("hex").slice(0, 16)}`,
      visibility: "project_visible",
      visibility_version: `${version}:unrestricted-read`,
      occurred_at: updatedAt,
      updated_at: updatedAt,
      operational_metadata: { page_id: page.id, space_key: page.space?.key },
      evidence: {
        source_type: normalized.source_type,
        ...(normalized.source_url ? { source_url: normalized.source_url } : {}),
        source_title: normalized.source_title,
        summary: normalized.summary,
        body: normalized.body,
        ...(normalized.author ? { author: normalized.author } : {}),
        metadata: normalized.metadata,
        confidence_score: 0.72,
        promotable: false,
      },
    };
  });
}

export async function pollConfluenceSource(
  orgId: string,
  projectId: string,
  resources: ProjectResources,
  dependencies: ConfluencePollDependencies = {},
): Promise<ConfluencePollResult> {
  const cql = buildConfluenceScopeCql(resources);
  const resourceBindingVersion = connectorBindingVersion(resources, "confluence");
  const identity = confluenceIdentity();
  if (!cql) {
    return {
      source_instance: identity?.sourceInstance ?? "unconfigured",
      changes: [],
      seen_page_ids: [],
      ineligible_page_ids: [],
      complete: true,
      pages_scanned: 0,
      pages_admitted: 0,
    };
  }
  if (!identity) {
    return {
      source_instance: "unconfigured",
      changes: [],
      seen_page_ids: [],
      ineligible_page_ids: [],
      complete: false,
      pages_scanned: 0,
      pages_admitted: 0,
      missing: "confluence_credentials_missing_or_invalid",
    };
  }
  if (!hasConfluenceProjectVisibilityPolicy()) {
    return {
      source_instance: identity.sourceInstance,
      changes: [],
      seen_page_ids: [],
      ineligible_page_ids: [],
      complete: false,
      pages_scanned: 0,
      pages_admitted: 0,
      missing: "confluence_project_visibility_policy_missing",
    };
  }

  const deps = {
    fetch: dependencies.fetch ?? globalThis.fetch,
    sleep: dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    retryAttempts: Math.max(1, dependencies.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS),
    requestTimeoutMs: Math.max(1_000, Math.min(60_000, dependencies.requestTimeoutMs ?? 15_000)),
  };
  const configuredMaxPages = Number(process.env.CONFLUENCE_MAX_PAGES);
  const maxPages = Math.max(
    1,
    dependencies.maxPages ?? (Number.isFinite(configuredMaxPages) && configuredMaxPages > 0
      ? configuredMaxPages
      : DEFAULT_MAX_PAGES),
  );
  const pageLimit = Math.max(1, Math.min(200, dependencies.pageLimit ?? DEFAULT_PAGE_LIMIT));
  const first = apiUrl(identity, "/rest/api/content/search");
  first.searchParams.set("cql", cql);
  first.searchParams.set("status", "current");
  first.searchParams.set("limit", String(pageLimit));
  first.searchParams.set("expand", "body.storage,version,space,ancestors,history.lastUpdated,history.createdBy");

  const changes: ProjectSourceChange[] = [];
  const seenPageIds = new Set<string>();
  const ineligiblePageIds = new Set<string>();
  let next: URL | null = first;
  let pagesScanned = 0;
  let pagesAdmitted = 0;
  let complete = true;
  let newestUpdatedAt: string | undefined;

  try {
    while (next && pagesScanned < maxPages) {
      const response: ConfluenceSearchPage = await fetchJson<ConfluenceSearchPage>(next, identity, deps);
      const pages = response.results ?? [];
      for (const page of pages) {
        if (pagesScanned >= maxPages) {
          complete = false;
          break;
        }
        pagesScanned++;
        seenPageIds.add(page.id);
        const updatedAt = pageUpdatedAt(page);
        if (updatedAt && (!newestUpdatedAt || updatedAt > newestUpdatedAt)) newestUpdatedAt = updatedAt;
        const visibility = await visibilityForPage(identity, page, deps);
        if (visibility !== "project_visible") {
          ineligiblePageIds.add(page.id);
          continue;
        }
        const sections = splitConfluenceSections(page.body?.storage?.value ?? page.body?.view?.value ?? "");
        if (sections.length === 0) continue;
        changes.push(...sectionChanges(orgId, projectId, identity, page, sections, resourceBindingVersion));
        pagesAdmitted++;
      }

      const rawNext = response._links?.next;
      if (!rawNext) {
        next = null;
      } else {
        next = validateConfluenceNextUrl(identity.base.toString(), rawNext);
        if (!next) throw new Error("confluence_invalid_next_url");
      }
    }
    if (next) complete = false;
  } catch (err) {
    const rawCode = err instanceof Error ? err.message : "";
    const code = /^confluence_(?:http_(?:\d{3}|failure)|fetch_failed|invalid_json|invalid_next_url)$/.test(rawCode)
      ? rawCode
      : "confluence_poll_failed";
    return {
      source_instance: identity.sourceInstance,
      changes,
      seen_page_ids: [...seenPageIds],
      ineligible_page_ids: [...ineligiblePageIds],
      complete: false,
      ...(newestUpdatedAt ? { newest_updated_at: newestUpdatedAt } : {}),
      pages_scanned: pagesScanned,
      pages_admitted: pagesAdmitted,
      missing: code,
    };
  }

  return {
    source_instance: identity.sourceInstance,
    changes,
    seen_page_ids: [...seenPageIds],
    ineligible_page_ids: [...ineligiblePageIds],
    complete,
    ...(newestUpdatedAt ? { newest_updated_at: newestUpdatedAt } : {}),
    pages_scanned: pagesScanned,
    pages_admitted: pagesAdmitted,
  };
}

interface ExistingConfluenceEvidence {
  source_instance: string;
  native_id: string | null;
  source_version: string | null;
  occurred_at: string;
  metadata_json: string;
}

function metadataPageId(raw: string): string | undefined {
  try {
    const value = JSON.parse(raw) as { page_id?: unknown };
    return typeof value.page_id === "string" ? value.page_id : undefined;
  } catch {
    return undefined;
  }
}

function reconciliationDeletes(
  orgId: string,
  projectId: string,
  result: ConfluencePollResult,
): ProjectSourceChange[] {
  const admittedNativeIds = new Set(result.changes
    .filter((change) => change.kind === "upsert")
    .map((change) => change.native_id));
  const seenPageIds = new Set(result.seen_page_ids);
  const ineligiblePageIds = new Set(result.ineligible_page_ids);
  const rows = db.prepare(
    `SELECT source_instance, native_id, source_version, occurred_at, metadata_json
     FROM project_evidence_items
     WHERE org_id = ? AND project_id = ? AND source = 'confluence' AND source_instance = ?`,
  ).all(orgId, projectId, result.source_instance) as unknown as ExistingConfluenceEvidence[];

  const deletes: ProjectSourceChange[] = [];
  for (const row of rows) {
    if (!row.native_id || admittedNativeIds.has(row.native_id)) continue;
    const pageId = metadataPageId(row.metadata_json) ?? row.native_id.split(":section:")[0];
    const pageWasReconciled = ineligiblePageIds.has(pageId)
      || seenPageIds.has(pageId)
      || (result.complete && !seenPageIds.has(pageId));
    if (!pageWasReconciled) continue;
    const restricted = ineligiblePageIds.has(pageId);
    deletes.push({
      kind: "delete",
      org_id: orgId,
      project_id: projectId,
      source: "confluence",
      source_instance: result.source_instance,
      native_id: row.native_id,
      ...(row.source_version ? { source_version: row.source_version } : {}),
      visibility: restricted ? "restricted" : "project_visible",
      visibility_version: restricted ? "restricted-read" : "reconciled-delete",
      occurred_at: row.occurred_at,
      updated_at: new Date().toISOString(),
    });
  }
  return deletes;
}

function setConfluenceWatermark(orgId: string, projectId: string, sourceInstance: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_ingestion_cursors
       (org_id, project_id, source, cursor_key, cursor_value, updated_at)
     VALUES (?, ?, 'confluence', ?, ?, ?)
     ON CONFLICT(org_id, project_id, source, cursor_key) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       updated_at = excluded.updated_at`,
  ).run(orgId, projectId, `site:${sourceInstance}:watermark`, value, now);
}

/** Poll, admit, persist, and reconcile the configured Confluence slice. Lexical
 * evidence is written synchronously; embeddings remain the refresh worker's
 * independent retryable step. */
export async function syncConfluenceProjectSource(
  orgId: string,
  projectId: string,
  resources: ProjectResources,
  dependencies: ConfluencePollDependencies = {},
): Promise<ConfluenceProjectSyncResult> {
  const configured = buildConfluenceScopeCql(resources) !== null;
  if (!configured) return { source: "confluence", ingested: 0, deleted: 0, quarantined: 0 };

  const attemptedAt = new Date().toISOString();
  let sourceInstance = "unconfigured";
  try {
    const polled = await pollConfluenceSource(orgId, projectId, resources, dependencies);
    sourceInstance = polled.source_instance;
    const policyRevoked = polled.missing === "confluence_project_visibility_policy_missing";
    const revokedPurge = policyRevoked
      ? purgeProjectEvidenceSource(orgId, projectId, "confluence")
      : null;
    recordProjectSourceSyncAttempt(orgId, projectId, "confluence", sourceInstance, attemptedAt);
    if (polled.missing) {
      recordProjectSourceSyncFailure(
        orgId,
        projectId,
        "confluence",
        sourceInstance,
        polled.missing,
        polled.missing,
        attemptedAt,
      );
      return {
        source: "confluence",
        ingested: 0,
        deleted: revokedPurge?.evidence_deleted ?? 0,
        quarantined: 0,
        missing: polled.missing,
      };
    }

    // A base-site change is a source-boundary change even when the project
    // keeps the same space/page keys. A complete scan of the new instance can
    // safely replace all older-instance derivatives before replaying changes.
    const sourceInstanceChanged = polled.complete && !!db.prepare(
      `SELECT 1 FROM project_evidence_items
       WHERE org_id = ? AND project_id = ? AND source = 'confluence' AND source_instance != ?
       LIMIT 1`,
    ).get(orgId, projectId, sourceInstance);
    const transitionPurge = sourceInstanceChanged
      ? purgeProjectEvidenceSource(orgId, projectId, "confluence")
      : null;

    const deletes = reconciliationDeletes(orgId, projectId, polled);
    const applied = await applySourceChanges(orgId, projectId, [...polled.changes, ...deletes]);
    if (polled.newest_updated_at) setConfluenceWatermark(orgId, projectId, sourceInstance, polled.newest_updated_at);
    if (polled.complete) recordProjectSourceReconciliation(orgId, projectId, "confluence", sourceInstance);

    const indexedCount = Number((db.prepare(
      `SELECT COUNT(*) AS count FROM project_evidence_items
       WHERE org_id = ? AND project_id = ? AND source = 'confluence' AND source_instance = ?`,
    ).get(orgId, projectId, sourceInstance) as { count: number }).count);
    const newestMillis = polled.newest_updated_at ? new Date(polled.newest_updated_at).getTime() : NaN;
    const lagSeconds = Number.isFinite(newestMillis)
      ? Math.max(0, Math.floor((Date.now() - newestMillis) / 1000))
      : undefined;
    const incomplete = !polled.complete;
    if (incomplete) {
      recordProjectSourceSyncFailure(
        orgId,
        projectId,
        "confluence",
        sourceInstance,
        "confluence_scan_incomplete",
        "confluence_scan_incomplete",
        attemptedAt,
      );
    } else {
      recordProjectSourceSyncSuccess(orgId, projectId, "confluence", sourceInstance, {
        attempted_at: attemptedAt,
        indexed_count: indexedCount,
        ...(lagSeconds !== undefined ? { lag_seconds: lagSeconds } : {}),
      });
    }
    return {
      source: "confluence",
      ingested: applied.upserted,
      deleted: applied.deleted + (transitionPurge?.evidence_deleted ?? 0),
      quarantined: applied.quarantined,
      ...(incomplete ? { missing: "confluence_scan_incomplete" } : {}),
    };
  } catch {
    const code = "confluence_sync_failed";
    recordProjectSourceSyncFailure(orgId, projectId, "confluence", sourceInstance, code, code, attemptedAt);
    return { source: "confluence", ingested: 0, deleted: 0, quarantined: 0, missing: code };
  }
}
