import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ContextSearchActor,
  ContextSearchHit,
  ContextSearchRequest,
  ContextSearchResult,
  ContextSource,
  ProjectResources,
  ProjectSearchSource,
  SearchDocument,
} from "@pim/shared";
import { CONTEXT_SOURCES } from "@pim/shared";
import { redactSecrets, scrubHits } from "./search-core/scrub.js";
import { synthesizeSearch } from "./search-core/synthesizer.js";
import { LIVE_SOURCE_AUTHORITY } from "./search-core/weights.js";
import { searchSlack } from "../integrations/slack.js";
import { searchFluffyjaws } from "../integrations/fluffyjaws.js";
import { searchJira, extractFixVersions } from "../integrations/jira.js";
import { searchConfluence } from "../integrations/confluence.js";
import { searchGithub } from "../integrations/github.js";
import { searchGit } from "../integrations/git.js";
import { searchKG } from "../integrations/kg.js";
import type { IntegrationResult, IntegrationSearchOpts } from "../integrations/types.js";
import db from "../db/connection.js";
import { detectPersonTokens, resolveActor, stripActivityPhrasing } from "./identity-resolver.js";
import { searchProject } from "./project-search.js";
import { redactProjectText } from "./project-evidence-normalization.js";
import { sanitizeProjectResources } from "./project-resource-bindings.js";

const DEFAULT_TIME_WINDOW_DAYS = 90;
const DEFAULT_MAX_HITS_PER_SOURCE = 10;
const DEFAULT_CACHE_TTL_SEC = 3600;
// Cap cache TTL when most sources failed, so a transient VPN/auth blip
// doesn't poison results for the full hour.
const PARTIAL_RESULT_CACHE_TTL_SEC = 300;
const CACHE_DIR = path.resolve(process.cwd(), ".data", "context-search-cache");
const PROMPT_PATH = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../../../../prompts/search-synthesis.md",
);

type Integration = (opts: IntegrationSearchOpts) => Promise<IntegrationResult>;

const INTEGRATIONS: Record<ContextSource, Integration> = {
  kg: searchKG,
  slack: searchSlack,
  fluffyjaws: searchFluffyjaws,
  jira: searchJira,
  confluence: searchConfluence,
  github: searchGithub,
  git: searchGit,
};

export interface ResolvedScope {
  project_id?: string;
  project_name?: string;
  project_resources?: ProjectResources;
  actor?: ContextSearchActor;
  /** Query with any matched project name/alias stripped out, so
   * integrations' text-search clauses don't over-constrain results.
   * The project scope itself is already encoded structurally via
   * project_resources. */
  cleaned_query?: string;
  /** True when the query reads as "what has X been up to" / "X recent
   * activity" / "X this week" — the natural-language phrasing is filler
   * once the actor is encoded as an authorship clause. Drop it from
   * per-integration text-match queries to avoid spurious hits on words
   * like "recent" or "activity". */
  is_activity_query?: boolean;
  /** Set when scope was filled in by a fallback rather than by an
   * explicit/pod/text-detected source. See ContextSearchResult.fallback. */
  fallback?: "authenticated_user";
}

export interface SearchContextOptions {
  /** Email of the IMS-authenticated caller, taken from req.user.email by
   * the route handler. When present and no other project/actor scope
   * resolves, the orchestrator falls back to scoping Jira to this user
   * (assignee/reporter/creator) and to the union of Jira project keys
   * across projects in orgs they belong to. Trust-mode dev users still
   * pass an email (DEV_USER_EMAIL) but their fallback typically yields
   * no project keys and no real Jira hits — which is the desired
   * fail-closed behavior for non-IMS callers. */
  authenticatedUserEmail?: string;
}

export function cacheKey(req: ContextSearchRequest, scope: ResolvedScope, orgId: string): string {
  const normalized = {
    cache_policy_version: 2,
    org_id: orgId,
    query: req.query.trim().toLowerCase(),
    sources: [...(req.sources ?? CONTEXT_SOURCES)].sort(),
    time_window_days: req.time_window_days ?? DEFAULT_TIME_WINDOW_DAYS,
    max_hits_per_source: req.max_hits_per_source ?? DEFAULT_MAX_HITS_PER_SOURCE,
    synthesize: req.synthesize !== false,
    query_mode: req.query_mode ?? "current",
    as_of: req.as_of ?? null,
    pod_id: req.pod_id ?? null,
    project_id: scope.project_id ?? null,
    project_resources: scope.project_resources ?? null,
    actor: scope.actor ?? null,
    // Include the fallback marker. A query with the IMS fallback and a
    // query with an explicit actor can resolve to the same scope.actor
    // (the caller themselves), but dispatch differently — the fallback
    // path keeps non-Jira sources broad; the explicit path scopes every
    // actor-aware source to that person. Without this field, the two
    // would collide on a single cache entry and poison each other for
    // the TTL. Synthesis output also differs (fallback strips actor from
    // the LLM prompt), so the cached summary_md must differ too.
    fallback: scope.fallback ?? null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

function readCache(key: string, ttlSec: number): ContextSearchResult | null {
  const p = cachePath(key);
  try {
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    const ageSec = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSec > ttlSec) {
      fs.unlinkSync(p);
      return null;
    }
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as ContextSearchResult;
  } catch {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best effort derived-cache cleanup */ }
    return null;
  }
}

function writeCache(
  key: string,
  result: ContextSearchResult,
  opts?: { fullTtlSec: number; effectiveTtlSec: number },
): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const p = cachePath(key);
    // Query text is reconstructed from the active request on a cache hit. It
    // never needs to cross the disk boundary, and the remainder is scrubbed as
    // one JSON payload so nested metadata and embedded credential URLs cannot
    // bypass field-specific output scrubbers.
    const cacheValue = { ...result, query: "[omitted]" };
    fs.writeFileSync(p, redactProjectText(JSON.stringify(cacheValue)).text, "utf-8");
    if (opts && opts.effectiveTtlSec < opts.fullTtlSec) {
      // Back-date mtime so the next read sees an older entry and respects
      // the shorter partial-result TTL even though readers compare against
      // the full env TTL.
      const offsetSec = opts.fullTtlSec - opts.effectiveTtlSec;
      const newMtimeMs = Date.now() - offsetSec * 1000;
      fs.utimesSync(p, new Date(), new Date(newMtimeMs));
    }
  } catch (err) {
    console.error("[context-search] cache write failed:", (err as Error).message);
  }
}

function loadProjectRow(projectId: string, orgId?: string):
  | { project_id: string; name: string; resources_json: string | null }
  | null {
  try {
    const row = (orgId
      ? db
          .prepare(
            "SELECT project_id, name, resources_json FROM projects WHERE project_id = ? AND org_id = ?",
          )
          .get(projectId, orgId)
      : db
          .prepare(
            "SELECT project_id, name, resources_json FROM projects WHERE project_id = ?",
          )
          .get(projectId)) as
      | { project_id: string; name: string; resources_json: string | null }
      | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function parseResources(raw: string | null): ProjectResources | undefined {
  if (!raw) return undefined;
  try {
    return sanitizeProjectResources(JSON.parse(raw) as ProjectResources);
  } catch {
    return undefined;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Scan the query text for any project's name or alias and return the
// best-matching project_id plus every term that matched (so the caller
// can strip them). Word-boundary, case-insensitive. Across different
// projects the longest single match wins (so "T3 Events" beats a stray
// "EMC" hit in a different project).
function detectProjectFromQuery(
  query: string,
  orgId?: string,
): { projectId: string; matchedTerms: string[] } | undefined {
  if (!query || query.trim().length === 0) return undefined;
  let rows: Array<{ project_id: string; name: string; resources_json: string | null }>;
  try {
    rows = orgId
      ? db
          .prepare("SELECT project_id, name, resources_json FROM projects WHERE org_id = ?")
          .all(orgId) as typeof rows
      : db
          .prepare("SELECT project_id, name, resources_json FROM projects")
          .all() as typeof rows;
  } catch {
    return undefined;
  }
  let best:
    | { id: string; longest: number; matched: string[] }
    | undefined;
  for (const row of rows) {
    const resources = parseResources(row.resources_json);
    const terms = [row.name, ...(resources?.aliases ?? [])].filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0,
    );
    const matched: string[] = [];
    let longest = 0;
    for (const term of terms) {
      // Lenient \b boundary for *detection* — if the query mentions a
      // version token like "T3-26.16" we still want it to resolve to
      // the "T3" project. (Stripping uses a stricter boundary below
      // so the token itself survives and becomes a fixVersion clause.)
      const re = new RegExp(`\\b${escapeRegex(term)}\\b`, "i");
      if (re.test(query)) {
        matched.push(term);
        if (term.length > longest) longest = term.length;
      }
    }
    if (matched.length > 0 && (!best || longest > best.longest)) {
      best = { id: row.project_id, longest, matched };
    }
  }
  return best ? { projectId: best.id, matchedTerms: best.matched } : undefined;
}

function stripTerms(query: string, terms: string[]): string {
  // Remove matched project names/aliases from the query and tidy the
  // leftover. Preserves word-boundary safety and collapses leftover
  // "in the", "for the" filler around the removed term.
  let out = query;
  // Sort longest-first so "T3 Events" is removed before the substring "T3".
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    const re = new RegExp(
      `(?<![\\w\\-.])${escapeRegex(term)}(?![\\w\\-.])`,
      "gi",
    );
    out = out.replace(re, " ");
  }
  return out
    .replace(/\b(in|for|on|of|the|at)\s+(in|for|on|of|the|at)\b/gi, "$1")
    .replace(/\b(in|for|on|about|regarding)\s*(project|pod)?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Walk users → memberships → orgs → projects.resources_json and union every
// project's Jira project_keys. Used as a last-resort scope when an IMS-
// authenticated caller issues an ad-hoc query that doesn't carry a
// project_id or pod and doesn't text-match any onboarded project. Returns
// [] when the user has no orgs, when their orgs have no projects, or when
// none of those projects have configured Jira keys.
export function loadJiraKeysForUserOrgs(email: string, orgId?: string): string[] {
  let rows: { resources_json: string }[];
  try {
    // Case-insensitive email match: IMS can return the same address in
    // different cases across sessions, and findUserByEmail (services/users.ts)
    // already follows this pattern. Matching exactly would silently drop
    // the user's project keys when their stored email casing differs.
    rows = orgId
      ? db
          .prepare(
            `SELECT p.resources_json
               FROM projects p
               JOIN memberships m ON m.org_id = p.org_id
               JOIN users u       ON u.user_id = m.user_id
              WHERE lower(u.email) = lower(?)
                AND p.org_id = ?
                AND p.resources_json IS NOT NULL`,
          )
          .all(email, orgId) as { resources_json: string }[]
      : db
          .prepare(
            `SELECT p.resources_json
               FROM projects p
               JOIN memberships m ON m.org_id = p.org_id
               JOIN users u       ON u.user_id = m.user_id
              WHERE lower(u.email) = lower(?)
                AND p.resources_json IS NOT NULL`,
          )
          .all(email) as { resources_json: string }[];
  } catch {
    return [];
  }
  const keys = new Set<string>();
  for (const r of rows) {
    const parsed = parseResources(r.resources_json);
    for (const k of parsed?.jira?.project_keys ?? []) keys.add(k);
  }
  return [...keys];
}

export async function resolveScope(
  req: ContextSearchRequest,
  orgIdOrAuthenticatedUserEmail?: string,
  authenticatedUserEmailArg?: string,
): Promise<ResolvedScope> {
  const secondArgLooksLikeEmail = orgIdOrAuthenticatedUserEmail?.includes("@") ?? false;
  const orgId = authenticatedUserEmailArg !== undefined
    ? orgIdOrAuthenticatedUserEmail
    : secondArgLooksLikeEmail
      ? undefined
      : orgIdOrAuthenticatedUserEmail;
  const authenticatedUserEmail =
    authenticatedUserEmailArg !== undefined
      ? authenticatedUserEmailArg
      : secondArgLooksLikeEmail
        ? orgIdOrAuthenticatedUserEmail
        : undefined;
  const scope: ResolvedScope = {};

  // 1. Project: explicit > inferred from pod > detected from query text
  let projectId = req.project_id;
  if (!projectId && req.pod_id) {
    try {
      const row = (orgId
        ? db
            .prepare("SELECT project_id FROM pods WHERE pod_id = ? AND org_id = ?")
            .get(req.pod_id, orgId)
        : db
            .prepare("SELECT project_id FROM pods WHERE pod_id = ?")
            .get(req.pod_id)) as { project_id: string | null } | undefined;
      projectId = row?.project_id ?? undefined;
    } catch {
      /* ignore */
    }
  }
  let detectedTerms: string[] = [];
  if (!projectId) {
    const detected = detectProjectFromQuery(req.query, orgId);
    if (detected) {
      projectId = detected.projectId;
      detectedTerms = detected.matchedTerms;
    }
  }
  if (projectId) {
    const row = loadProjectRow(projectId, orgId);
    if (row) {
      scope.project_id = row.project_id;
      scope.project_name = row.name;
      scope.project_resources = parseResources(row.resources_json);
      if (detectedTerms.length > 0) {
        const cleaned = stripTerms(req.query, detectedTerms);
        if (cleaned && cleaned !== req.query) scope.cleaned_query = cleaned;
      }
    }
  }

  // 2. Actor: explicit > detected from query text
  const tokens = detectPersonTokens(req.query);
  if (req.actor) {
    scope.actor = req.actor;
  } else if (tokens.email || tokens.slack_user_id) {
    scope.actor = await resolveActor(tokens);
  }
  // Activity-style queries are detected from phrasing OR from the
  // common "<email> recent activity" shape — when present alongside an
  // actor, integrations should rely on authorship filters rather than
  // matching the natural-language phrasing as text.
  scope.is_activity_query = tokens.is_activity_query;

  // 3. Last-resort IMS fallback. Only activates when no project AND no
  // actor resolved AND the query carries no fixVersion token AND the
  // caller is an authenticated user. Scopes Jira (and any other
  // integration that respects actor/project_resources) to the caller's
  // identity and to the Jira project keys of every project in the orgs
  // they belong to. The fixVersion gate is important: a query like
  // "what's in T3-26.16" already satisfies the Jira scope guard via the
  // release token, and narrowing it to the caller as actor would silently
  // drop teammates' contributions to the same release.
  const queryFixVersions = extractFixVersions(req.query).versions;
  if (
    !scope.project_id &&
    !scope.actor &&
    queryFixVersions.length === 0 &&
    authenticatedUserEmail
  ) {
    const actor = await resolveActor({
      email: authenticatedUserEmail,
      cleaned_query: req.query,
      is_activity_query: false,
    });
    if (actor) {
      scope.actor = actor;
      scope.fallback = "authenticated_user";
      const orgProjectKeys = loadJiraKeysForUserOrgs(authenticatedUserEmail, orgId);
      if (orgProjectKeys.length > 0) {
        scope.project_resources = {
          ...scope.project_resources,
          jira: {
            ...scope.project_resources?.jira,
            project_keys: orgProjectKeys,
          },
        };
      }
    }
  }

  return scope;
}

/** Adapt a `SearchDocument` (connector output) to a `ContextSearchHit` for the
 *  live ranking pipeline. This keeps the ranker, dedup, and synthesis paths
 *  unchanged while the connectors move to the unified document shape.
 */
function toContextHit(doc: SearchDocument): ContextSearchHit {
  return {
    source: doc.source as ContextSource,
    title: doc.title,
    url: doc.source_url,
    snippet: doc.snippet,
    author: doc.author,
    timestamp: doc.timestamp,
    metadata: doc.metadata,
  };
}

function boostFor(hit: ContextSearchHit, resources?: ProjectResources): number {
  if (!resources) return 0;
  const url = (hit.url ?? "").toLowerCase();
  const meta = (hit.metadata ?? {}) as Record<string, unknown>;

  const jiraKeys = resources.jira?.project_keys ?? [];
  if (hit.source === "jira") {
    const key = (meta.key as string | undefined) ?? "";
    if (jiraKeys.some((k) => key.startsWith(`${k}-`))) return 2;
  }
  const repos = resources.github?.repos ?? [];
  if (hit.source === "github") {
    const repo = (meta.repo as string | undefined) ?? "";
    if (repos.includes(repo)) return 2;
  }
  const channels = (resources.slack?.channels ?? []).map((c) => c.replace(/^#/, ""));
  if (hit.source === "slack") {
    const match = hit.title.match(/#([^\s(]+)/);
    if (match && channels.includes(match[1])) return 2;
  }
  const spaces = resources.confluence?.space_keys ?? [];
  if (hit.source === "confluence" && spaces.length > 0) {
    if (spaces.some((k) => url.includes(`/spaces/${k.toLowerCase()}/`) || url.includes(`spacekey=${k.toLowerCase()}`))) {
      return 2;
    }
  }
  return 0;
}

function rankHits(
  hits: ContextSearchHit[],
  query: string,
  resources?: ProjectResources,
): ContextSearchHit[] {
  const now = Date.now();
  const q = query.toLowerCase();
  const phrases = q.split(/\s+/).filter(Boolean);

  return [...hits].sort((a, b) => score(b) - score(a));

  function score(h: ContextSearchHit): number {
    const authority = LIVE_SOURCE_AUTHORITY[h.source] ?? 0;
    const text = `${h.title} ${h.snippet}`.toLowerCase();
    const exact = text.includes(q) ? 3 : 0;
    const phraseHits = phrases.filter((p) => text.includes(p)).length;
    const recency = h.timestamp
      ? Math.max(0, 2 - (now - new Date(h.timestamp).getTime()) / (30 * 24 * 3600 * 1000))
      : 0;
    // KG bonus: curated nodes beat extracted ones; high-confidence beats low.
    let kgBonus = 0;
    if (h.source === "kg") {
      const meta = (h.metadata ?? {}) as Record<string, unknown>;
      if (meta.curated === true) kgBonus += 2;
      const confScore = typeof meta.confidence_score === "number" ? meta.confidence_score : 0;
      kgBonus += confScore * 1.5;
    }
    return authority + exact + phraseHits * 0.5 + recency + kgBonus + boostFor(h, resources);
  }
}

function dedupe(hits: ContextSearchHit[]): ContextSearchHit[] {
  const seen = new Map<string, ContextSearchHit>();
  for (const h of hits) {
    const key = (h.url ?? "") + "|" + h.title.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, h);
  }
  return [...seen.values()];
}

const PROJECT_CONTEXT_SOURCES = new Set<ContextSource>([
  "kg", "slack", "jira", "confluence", "github", "git",
]);

/** Delegate current, actor-free project context queries to the deterministic
 * indexed retrieval core. Actor and temporal modes retain their existing live
 * paths until equivalent pre-candidate filters exist in project search. */
async function searchIndexedProjectContext(
  req: ContextSearchRequest,
  scope: ResolvedScope,
  orgId: string,
): Promise<ContextSearchResult | null> {
  if (!scope.project_id || req.pod_id || scope.actor || (req.query_mode ?? "current") !== "current") return null;
  const selected = req.sources ?? CONTEXT_SOURCES;
  const indexedSources = selected.filter((source) => PROJECT_CONTEXT_SOURCES.has(source));
  if (indexedSources.length === 0) return null;

  const query = scope.cleaned_query?.trim() || req.query;
  const response = await searchProject(orgId, scope.project_id, {
    query,
    sources: indexedSources as ProjectSearchSource[],
    time_window_days: req.time_window_days ?? DEFAULT_TIME_WINDOW_DAYS,
    max_hits: Math.min(50, (req.max_hits_per_source ?? DEFAULT_MAX_HITS_PER_SOURCE) * indexedSources.length),
    include_kg: indexedSources.includes("kg"),
    synthesize: req.synthesize !== false,
  });
  if (!response) return null;

  const hits: ContextSearchHit[] = response.hits.map((hit) => ({
    source: hit.source as ContextSource,
    title: hit.title,
    ...(hit.url ? { url: hit.url } : {}),
    snippet: hit.snippet,
    ...(hit.author ? { author: hit.author } : {}),
    ...(hit.occurred_at ? { timestamp: hit.occurred_at } : {}),
    metadata: {
      source_id: hit.source_id,
      source_type: hit.source_type,
      freshness: hit.freshness,
      score: hit.score,
      matched: hit.matched,
      ...(hit.status ? { status: hit.status } : {}),
      ...(hit.chunk_id ? { chunk_id: hit.chunk_id } : {}),
      document_id: hit.document_id,
    },
  }));
  for (const kg of response.kg_overlay ?? []) {
    hits.push({
      source: "kg",
      title: kg.summary,
      url: kg.url,
      snippet: kg.snippet,
      metadata: {
        node_id: kg.id,
        confidence_score: kg.confidence_score,
        curated: kg.curated === true,
      },
    });
  }

  const actualSources = new Set<ContextSource>();
  for (const source of response.sources_used) {
    const contextSource = source as ContextSource;
    if (PROJECT_CONTEXT_SOURCES.has(contextSource)) actualSources.add(contextSource);
  }
  if ((response.kg_overlay?.length ?? 0) > 0) actualSources.add("kg");
  const explicitlyUnsupported = req.sources?.filter((source) => !PROJECT_CONTEXT_SOURCES.has(source)) ?? [];
  return {
    query: redactProjectText(req.query).text,
    project_id: response.project_id,
    project_name: response.project_name ?? scope.project_name,
    summary_md: response.summary_md,
    hits: dedupe(scrubHits(hits)),
    sources_used: [...actualSources],
    missing_sources: explicitlyUnsupported.map((source) => ({
      source,
      reason: "Source is not available in indexed project retrieval",
    })),
    from_cache: false,
    generated_at: response.generated_at,
  };
}

async function synthesize(
  query: string,
  hits: ContextSearchHit[],
  scope: ResolvedScope,
): Promise<string | undefined> {
  // The IMS-authenticated-user fallback supplies an actor solely so the
  // Jira fail-closed scope guard has a narrowing dimension; it never
  // narrows the other sources (see searchContext dispatch). The synthesis
  // prompt's contract is "actor = all hits are filtered to this person",
  // so passing scope.actor through here would make the LLM write "your
  // work on X" around broad Slack/GitHub/KG hits — and, worst case, around
  // a sources list that excluded Jira entirely (no source was actor-
  // scoped at all). Treat the fallback as Jira-internal: present the
  // synthesis with a view of the scope that has no actor when the
  // fallback fired. The response still echoes scope.actor and
  // scope.fallback for the caller to render however they like.
  const effectiveActor =
    scope.fallback === "authenticated_user" ? undefined : scope.actor;

  if (hits.length === 0) {
    if (scope.project_name || effectiveActor?.display_name) {
      const who = effectiveActor?.display_name ?? effectiveActor?.email;
      const where = scope.project_name ? `in ${scope.project_name}` : "";
      return `No matching activity found ${[who ? `by ${who}` : "", where].filter(Boolean).join(" ")} for this query.`.trim();
    }
    return undefined;
  }

  const md = await synthesizeSearch({
    systemPromptPath: PROMPT_PATH,
    evidence: {
      mode: "live",
      query,
      hits,
      project_scope: scope.project_name
        ? {
            name: scope.project_name,
            aliases: scope.project_resources?.aliases ?? [],
            resources: scope.project_resources,
          }
        : undefined,
      actor: effectiveActor,
    },
    maxTokens: 1500,
    label: "context-search",
  });
  // Belt-and-suspenders: scrub any secrets that may have slipped through
  // into the synthesized markdown itself.
  return md !== undefined ? redactSecrets(md).text : undefined;
}

export async function searchContext(
  req: ContextSearchRequest,
  orgId: string,
  opts: SearchContextOptions = {},
): Promise<ContextSearchResult> {
  const ttlSec = parseInt(process.env.CONTEXT_SEARCH_CACHE_TTL_SEC ?? String(DEFAULT_CACHE_TTL_SEC), 10);

  const scope = await resolveScope(req, orgId, opts.authenticatedUserEmail);
  const safeQuery = redactProjectText(req.query).text;

  // The indexed project wrapper shares the policy-aware retrieval core and is
  // deliberately uncached during the deterministic MVP phase.
  const indexedProjectResult = await searchIndexedProjectContext(req, scope, orgId);
  if (indexedProjectResult) return indexedProjectResult;

  // Legacy live cache entries cannot safely outlive Slack/Confluence
  // visibility changes or reconciliation. Keep those sources uncached.
  const selectedForCache = req.sources ?? CONTEXT_SOURCES;
  const policySensitive = selectedForCache.includes("slack") || selectedForCache.includes("confluence");
  const useCache = req.use_cache !== false && !policySensitive;

  const key = cacheKey(req, scope, orgId);
  if (useCache) {
    const cached = readCache(key, ttlSec);
    if (cached) return { ...cached, query: safeQuery, from_cache: true };
  }

  // Build the per-integration query. When an actor is set and the query
  // reads as activity ("rea01581@adobe.com recent activity", "what has X
  // been up to"), the natural-language phrasing is filler — strip it so
  // text-match clauses don't anchor on words like "recent" or "activity".
  // The KG keeps the unmodified query because semantic ranking benefits
  // from intent words.
  let perSourceQuery = redactProjectText(scope.cleaned_query ?? req.query).text;
  if (scope.is_activity_query && scope.actor) {
    perSourceQuery = stripActivityPhrasing(perSourceQuery, scope.actor) || "";
  }

  const integrationOpts: IntegrationSearchOpts = {
    query: perSourceQuery,
    time_window_days: req.time_window_days ?? DEFAULT_TIME_WINDOW_DAYS,
    max_hits_per_source: req.max_hits_per_source ?? DEFAULT_MAX_HITS_PER_SOURCE,
    org_id: orgId,
    pod_id: req.pod_id,
    project_id: scope.project_id,
    project_name: scope.project_name,
    project_resources: scope.project_resources,
    actor: scope.actor,
    query_mode: req.query_mode ?? "current",
    as_of: req.as_of,
  };
  // When the actor came from the IMS-authenticated-user fallback, only
  // Jira needs it to satisfy its fail-closed scope guard. Carrying it to
  // the other integrations would silently narrow Slack/GitHub/Git to the
  // caller's own messages, commits, and PRs for an ad-hoc query like
  // "milo block init" — which is not what the caller asked for. Strip
  // the actor from every non-Jira source in that case; the explicit /
  // query-detected actor paths still flow through untouched.
  const fromIMSFallback = scope.fallback === "authenticated_user";
  const nonJiraOpts: IntegrationSearchOpts = fromIMSFallback
    ? { ...integrationOpts, actor: undefined }
    : integrationOpts;
  // The KG always sees the original query — semantic search benefits from
  // the intent phrasing other integrations have to drop. It also follows
  // the Jira-only-actor rule when the fallback fired.
  const kgOpts: IntegrationSearchOpts = { ...nonJiraOpts, query: safeQuery };

  const selected = (req.sources ?? CONTEXT_SOURCES).filter((s) => s in INTEGRATIONS);
  const settled = await Promise.allSettled(
    selected.map((s) => {
      if (s === "kg") return INTEGRATIONS[s](kgOpts);
      if (s === "jira") return INTEGRATIONS[s](integrationOpts);
      return INTEGRATIONS[s](nonJiraOpts);
    }),
  );

  const missing_sources: ContextSearchResult["missing_sources"] = [];
  const allHits: ContextSearchHit[] = [];
  const sources_used: ContextSource[] = [];

  settled.forEach((r, i) => {
    const source = selected[i];
    if (r.status === "rejected") {
      missing_sources.push({ source, reason: `${source}_connector_failed` });
      return;
    }
    const res = r.value;
    if (res.missing) {
      missing_sources.push({ source, reason: `${source}_connector_unavailable` });
      return;
    }
    // Success (no error) → report as used even when 0 hits, so callers
    // can distinguish "searched, nothing matched" from "never ran".
    sources_used.push(source);
    if (res.documents.length > 0) allHits.push(...res.documents.map(toContextHit));
  });

  const ranked = rankHits(dedupe(scrubHits(allHits)), req.query, scope.project_resources);

  const summary_md =
    req.synthesize !== false ? await synthesize(safeQuery, ranked, scope) : undefined;

  const result: ContextSearchResult = {
    query: safeQuery,
    project_id: scope.project_id,
    project_name: scope.project_name,
    actor: scope.actor,
    fallback: scope.fallback,
    summary_md,
    hits: ranked,
    sources_used,
    missing_sources,
    from_cache: false,
    generated_at: new Date().toISOString(),
  };

  if (useCache) {
    // Don't poison the cache with mostly-failed results — a transient VPN or
    // auth blip can take down half the integrations and we don't want to
    // serve that for an hour. When more than half of the selected sources
    // came back missing, shorten the effective TTL.
    const failureRatio = missing_sources.length / Math.max(1, selected.length);
    const isPartial = failureRatio > 0.5;
    writeCache(
      key,
      { ...result, cached_at: result.generated_at },
      isPartial ? { fullTtlSec: ttlSec, effectiveTtlSec: PARTIAL_RESULT_CACHE_TTL_SEC } : undefined,
    );
  }

  return result;
}
