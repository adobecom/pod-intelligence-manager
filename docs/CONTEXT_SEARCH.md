# Context Search

**Status:** current feature guide. Dated live-result counts below are retained as test evidence,
not as a production availability guarantee.

Cross-source search across Adobe-internal context (Slack, Fluffyjaws, Jira, Confluence, GitHub, local git), exposed through the PIM backend and callable from Claude Desktop, Claude Code, the PIM UI, the `pim` CLI, and pod agents mid-debug.

## What it is

Adobe engineers answering "has anyone done X?", "what's the status of Y?", or "what breaks if I change Z?" today fan out manually: a Jira search, three Slack searches (mwp/aem-engineering/adobedotcom), a Fluffyjaws semantic query, maybe a Confluence search, and a GitHub code search. Section 7 of `claude-code-guide-for-victor.md` documents this workflow and the `/tmp/claude-research-*.md` cache pattern Claude Code users adopted to avoid re-running the same seven searches every turn.

Context Search collapses that into **one request** that runs server-side:

```
context_search({query: "milo block init pattern"})
  →  {
       summary_md: "## Summary\nMilo blocks export a default async `init(el)` …\n## Sources\n1. [F1] Fluffyjaws — …\n2. [C6] Confluence — Use AI to contribute to Milo …\n3. [G1] GitHub — adobecom/milo/…",
       hits: [ {source, title, url, snippet, author, timestamp, metadata}, … ],
       sources_used: ["fluffyjaws","confluence","github","jira"],
       missing_sources: [],
       from_cache: false,
       generated_at: "2026-04-17T…"
     }
```

The summary is a Haiku-generated markdown synthesis with inline citations; the raw hits sit underneath so agents (and humans) can drill into the specific Slack thread, Jira ticket, or commit. Results are cached for one hour so repeat queries are free.

## Why we built it this way

Four decisions shaped the design:

1. **Server-side fan-out, not a client skill.** MCP tools cannot invoke other MCPs on the client, so the only way one tool call can return unified results in **both** Claude Desktop and Claude Code is for the fan-out to happen on the PIM backend. Hosted deployments supply the same integration credentials through the server's managed configuration.
2. **Both humans and agents invoke it.** One endpoint, three triggers: the CLI and UI for on-demand human queries, the `context_search` MCP tool for Claude Desktop / Code, and `get_agent_session_context` (the pod-agent protocol pull step) for agents at session start *and* mid-debug.
3. **Synthesized markdown + raw hits.** The synthesis goes through Haiku (cheap, ~$0.001/query) and is cached to disk; the raw hits travel alongside so the caller can drill down without a second round-trip. Both formats survive the cache.
4. **Pod-agnostic.** `pod_id` is optional and only used to bias local-git search and ranking. A query without a pod works fine — the MCP tool, CLI, and UI all support headless use outside a pod context.

## Architecture

```
Claude Desktop / Claude Code                PIM UI            pim CLI
        │                                        │                      │
        │ tool: context_search(query, …)         │ POST /api/…          │ pim search "…"
        ▼                                        ▼                      ▼
  packages/mcp-server ────────────────────►  /api/context-search  ◄─── packages/cli
  (tools.ts: context_search)                     (Fastify)              (commands/search.ts)
                                                    │
                                                    ▼
                                     packages/server/services/context-search.ts
                                                    │
          ┌──────────────┬───────────┬──────────────┼──────────────┬──────────────┬──────────┐
          ▼              ▼           ▼              ▼              ▼              ▼
     integrations/  integrations/  integrations/  integrations/  integrations/  integrations/
     slack.ts       fluffyjaws.ts  jira.ts        confluence.ts  github.ts      git.ts
     (@slack/       (cookie auth,  (Bearer PAT    (Bearer PAT    (Bearer +      (execFile
      web-api ×3)    /conversation  on-prem;       on-prem;       org scope)     git log
                    /create →       Basic Cloud)   Basic Cloud)                   grep +
                    /stream SSE)                                                  pickaxe)
                                                    │
                                                    ▼
                                              normalize + dedupe
                                                    │
                                                    ▼
                               secret-scrub (services/secret-scan.ts, regex redact)
                                                    │
                                                    ▼
                  synthesize via callLLM(MODELS.fast, prompts/context-search-synthesis.md)
                                                    │
                                                    ▼
                              cache (.data/context-search-cache/<sha256>.json, 1h TTL)
                                                    │
                                                    ▼
                        { summary_md, hits, sources_used, missing_sources, … }
```

**Agent auto-pull path:** `PimClient.pullSessionContext({externalQuery})` adds a sixth fetch to the existing `Promise.allSettled` in the pod-agent protocol's pull step. The MCP's `get_agent_session_context` exposes the same param. The same task-specific query also guides KG learning retrieval; when omitted, learnings use broad scope-ranked retrieval rather than pod milestone or project-name filtering. Both return the context-search result bundled under `externalContext` / `external_context` alongside the living doc, conflicts, learnings, and recent updates.

## Sources

All six follow the same contract — `async function search<Source>(opts) → {source, hits, missing?}` — and degrade gracefully when credentials are absent: the source is silently skipped and a clear reason appears in `missing_sources` on the response.

### Slack (3 workspaces)
- **File:** `packages/server/src/integrations/slack.ts`
- **Client:** `@slack/web-api` (already installed).
- **Env:** `SLACK_USER_TOKEN_MWP`, `SLACK_USER_TOKEN_AEM_ENG`, `SLACK_USER_TOKEN_ADOBEDOTCOM`. Any subset works; empty workspaces are skipped.
- **Auth:** User tokens (not bot) — `search.messages` requires `search:read`, which bot tokens don't get by default. Slack's granular `search:read.public` scope is rejected by `search.messages` (a known Slack inconsistency), so use the broader `search:read`. The integration filters out non-public channels (`is_private`, `is_im`, `is_mpim`) server-side so only public-channel hits leave the server regardless of what the user's token can technically reach.
- **Query:** `{query} after:{YYYY-MM-DD}` (derived from `time_window_days`), sorted by timestamp descending.
- **Hit shape:** `title: "#channel (workspace)"`, `url: permalink`, `author: username`, `timestamp: ISO`.

### Fluffyjaws
- **File:** `packages/server/src/integrations/fluffyjaws.ts`
- **API shape:** Fluffyjaws is a **conversational RAG**, not a REST search — reverse-engineered from `~/.local/share/fj/fj.mjs` v0.2.0.
- **Flow:** `POST /api/conversation/create {temporary:true}` → `POST /api/stream` with OpenAI-style Responses SSE, collecting `response.output_text.delta` events into one synthesized hit.
- **Env:** `FLUFFYJAWS_SESSION_ID` (session cookie from `~/.config/fj/session.json`; `fj login` refreshes). `FLUFFYJAWS_BASE_URL` defaults to `https://api.fluffyjaws.adobe.com`.
- **Auth:** `Cookie: fjv3_session=<id>` — **not Bearer.**
- **Reasoning effort:** `medium` is the minimum that works because Fluffyjaws auto-attaches `code_interpreter` which rejects `minimal`. Valid wire values: `none | minimal | low | medium | high | xhigh`.
- **Hit shape:** a single `ContextSearchHit` with the full synthesis as the snippet (truncated to 1200 chars), `metadata.low_trust: true` so the synthesizer cross-checks specific claims against non-low-trust sources before stating them as fact.
- **Requires VPN.**

### Jira
- **File:** `packages/server/src/integrations/jira.ts`
- **Env:** `JIRA_BASE_URL`, `JIRA_TOKEN`, `JIRA_EMAIL` (optional, only for Cloud).
- **Flavor detection:**
  - `*.atlassian.net` + `JIRA_EMAIL` set → Atlassian Cloud: `Basic {email}:{token}` + `/rest/api/3/search`.
  - Anything else (e.g. `jira.corp.adobe.com`) → on-prem Jira Server: `Bearer {PAT}` + `/rest/api/2/search`.
- **Query:** JQL composed of optional narrowing clauses + a text match + a recency window. Example with all narrowings: `project in ("MWPW") AND "Team" = "Strata" AND (assignee = "x@adobe.com" OR reporter = "x@adobe.com" OR creator = "x@adobe.com") AND fixVersion in ("T3-26.16") AND text ~ "milo" AND updated >= -90d ORDER BY updated DESC`. The `updated` window is dropped when a `fixVersion` clause is present, since release tickets span months.
- **Scope guard (fail-closed):** Jira will refuse to run a search unless at least one narrowing dimension is present: project keys, a Jira `"Team"` value (both from project resources), an actor (assignee/reporter/creator email), or a release-version token in the query (e.g. `T3-26.16`). Unscoped full-text JQL against Adobe's shared Jira instance (~35K users) is one of the most expensive queries the API will run, so the integration returns `{ source: "jira", hits: [], missing: "Jira search refused: …" }` and the rest of the fan-out (Slack/Confluence/GitHub/Fluffyjaws/Git/KG) still runs. To unblock Jira, configure `project_resources.jira.project_keys` or `project_resources.jira.team` for the project (see [Project scoping](#project-scoping-onboarding)), pass an explicit `project_id`, sign in via IMS so the server can fall back to your identity (see resolution step 5 below), or include a fixVersion token in the query.
- **Hit shape:** `title: "KEY: summary"`, `url: /browse/KEY`, `metadata: {key, status, assignee}`.

### Confluence
- **File:** `packages/server/src/integrations/confluence.ts`
- **Env:** `CONFLUENCE_BASE_URL`, `CONFLUENCE_TOKEN`. `CONFLUENCE_EMAIL` defaults to `JIRA_EMAIL` since Adobe's Jira + Wiki share an IDP. Project-scoped indexing/search additionally requires an operator-reviewed comma-separated `CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS` or `CONFLUENCE_PROJECT_VISIBLE_PAGE_IDS` allowlist. Every listed scope must be visible to the full PIM project audience; direct and inherited page restrictions are still checked dynamically.
- **Flavor detection:** same rule as Jira.
- **CQL:** `text ~ "{query}" AND lastmodified >= "{YYYY-MM-DD}"`. **Absolute dates only** — on-prem Confluence Server rejects the `"-90d"` relative syntax that Cloud accepts.
- **Hit shape:** `title: page title`, `url: base + _links.webui`, snippet from `body.view.value` with tags stripped.

### GitHub
- **File:** `packages/server/src/integrations/github.ts`
- **Env:** `GH_TOKEN` (classic or fine-grained), `GITHUB_SEARCH_ORGS` (comma-separated; default covers `adobecom,adobe-rnd`).
- **Endpoints:** `/search/code` and `/search/issues` in parallel, scoped with `org:X org:Y`.
- **Hit shape:** code hits use `repository/path` + `text_matches.fragment`; issue/PR hits include author, timestamp, state, and a `pull_request` flag for PR vs. issue disambiguation.
- **Rate limit:** GitHub Search API is 30 req/min authenticated. Each query spends 2 (code + issues).

### Git (local)
- **File:** `packages/server/src/integrations/git.ts`
- **Requires:** a `repo_path` column on the `pods` table (not yet in the schema — integration is ready and reports a clean `missing_sources` reason until the migration lands).
- **Executed via:** `execFile("git", ["log", "--grep", query, …])` and `git log -S "query"` (pickaxe) — no shell, no injection surface.
- **Hit shape:** commit-level context with 7-char hash, author, date, subject, body.

## Output

```ts
interface ContextSearchResult {
  query: string;
  summary_md?: string;          // Haiku-generated; absent if no hits or LLM unavailable
  hits: ContextSearchHit[];     // deduped, ranked, secret-scrubbed
  sources_used: ContextSource[];
  missing_sources: { source: ContextSource; reason: string }[];
  from_cache: boolean;
  cached_at?: string;
  generated_at: string;
}
```

Ranking inside `context-search.ts`:

- **Source authority:** Jira, Confluence > GitHub, Git > Slack-live > Fluffyjaws-archive
- **Exact phrase match** in title/snippet → +3
- **Recency:** hits from the last 30 days get a small boost
- **Dedupe:** `url|lowercased title` as the key

Synthesis follows `prompts/context-search-synthesis.md`, which enforces:

- Inline citations `[F1] [J2] [C3] [G4] [S5] [X6]` keyed to a `## Sources` list
- **Cross-check rule:** specific facts (names, dates, numbers) that only appear in a `low_trust` hit (Fluffyjaws) must be hedged ("Fluffyjaws suggests…") unless corroborated by a non-low-trust source
- **Never quote a secret** — even though hits are already redacted, this is belt-and-suspenders

## Surfaces

### MCP (Claude Desktop / Claude Code)

Registered in `packages/mcp-server/src/tools.ts`:

```
context_search({
  query: string,
  sources?: ("slack"|"fluffyjaws"|"jira"|"confluence"|"github"|"git")[],
  pod_id?: string,
  time_window_days?: number,   // default 90
  max_hits_per_source?: number, // default 10
  synthesize?: boolean,         // default true
  use_cache?: boolean,          // default true
})
```

Plus the existing `get_agent_session_context` now takes an optional `external_query` that forwards through `pullSessionContext` and bundles the result under `external_context`.

### CLI

```bash
pim search "milo block init" --sources=jira,confluence --days=30
pim search "…" --json       # full JSON response
pim search "…" --brief      # summary only, no raw hits
pim search "…" --raw        # raw hits only, skip summary
pim search "…" --no-cache   # force fresh fan-out
pim search "…" --no-synthesize  # skip the Haiku call
```

Implemented in `packages/cli/src/commands/search.ts`. Does **not** require `PIM_POD_ID` or scope.

### SDK

```ts
// Pod-scoped: client.searchContext(query, opts?) includes pod_id automatically
const client = new PimClient({ baseUrl, agentId, scope, podId });
await client.searchContext("stripe integration", { sources: ["jira"] });

// Pod-less helper: import searchContext directly
import { searchContext } from "@pim/sdk";
await searchContext("http://localhost:4000", { query: "…" });

// Agent auto-pull includes it alongside the living doc / conflicts / learnings
await client.pullSessionContext({ externalQuery: "checkout" });
// → returns { pulledAt, pod, livingDocMarkdown, conflicts, relevantLearnings,
//             recentUpdates, externalContext }
```

### UI

- Route: `/search` (sibling of `/knowledge`).
- View: `packages/ui/src/views/ContextSearch/ContextSearch.tsx` — Spectrum 2 `SearchField`, per-source checkboxes, day-window input, rendered markdown summary + per-hit cards with drill-down links.
- Store: `packages/ui/src/stores/searchStore.ts` (Zustand).

## Security

Three checkpoints mirror the repository's established fetch, process, and response secret controls:

1. **Post-fetch redaction** — every hit's `title` and `snippet` passes through `redactSecrets()` in `packages/server/src/services/secret-scan.ts`. AWS keys, JWTs, connection strings, PEM keys, and `password|token|api_key = "…"` patterns are replaced with `[REDACTED:Name]`.
2. **Synthesis prompt guardrail** — the Haiku system prompt explicitly instructs the model to summarize the presence of a secret without quoting the value.
3. **Pre-response redaction** — `summary_md` also runs through `redactSecrets()` before being returned or cached.

Cache files on disk contain only redacted content.

## Caching

- **Location:** `.data/context-search-cache/<sha256>.json` under the server's working directory. On the hosted EC2 deployment, `.data` resolves onto the persistent `/data` EBS volume.
- **Key:** `sha256(JSON.stringify({ query: lowercased/trimmed, sources: sorted, time_window_days, max_hits_per_source, synthesize, pod_id }))`.
- **TTL:** `CONTEXT_SEARCH_CACHE_TTL_SEC` (default `3600` = 1 hour). Cache files older than TTL are ignored on read; the orchestrator overwrites them on the next fresh query.
- **Bypass:** `use_cache: false` in the request body (CLI: `--no-cache`).

Cache hits are ~10–50 ms; a fresh fan-out is typically 2–6 seconds (Fluffyjaws streaming dominates; the other five run in parallel).

## Live verification

Tested against the user's real session cookie + Adobe-internal endpoints on 2026-04-17:

| Source | Live hit count | Notes |
|--------|---------------:|-------|
| Fluffyjaws | 1 (5.9KB synthesis) | Inline Experience League citations |
| Jira | 10 | Real tickets across CCD / MWPW / CSME projects |
| Confluence | 10 | Real wiki pages (Milo docs) |
| GitHub | 5 | Real code across `adobecom/milo`, `adobecom/dc`, `adobecom/da-express-milo` |
| Slack | 0 | Token present but workspace needs `search:read` user scope |
| Git | 0 | Requires `pods.repo_path` migration (deferred) |

Haiku synthesis worked end-to-end; cross-check rule produced a summary that hedged Fluffyjaws-only claims and stated only facts corroborated by Confluence or GitHub.

## File map

### New
- `packages/shared/src/types/context-search.ts` — request/hit/result types
- `packages/server/src/integrations/{types,slack,fluffyjaws,jira,confluence,github,git}.ts` — one per source
- `packages/server/src/services/context-search.ts` — orchestrator, dedupe, rank, secret-scrub, synthesize, cache
- `packages/server/src/routes/context-search.ts` — Fastify route + Zod validation
- `packages/cli/src/commands/search.ts` — `pim search`
- `packages/ui/src/views/ContextSearch/ContextSearch.tsx` + `stores/searchStore.ts`
- `prompts/context-search-synthesis.md` — Haiku system prompt

### Edited
- `packages/server/src/services/secret-scan.ts` — added `redactSecrets()` reusing existing regex patterns
- `packages/server/src/index.ts` — registered the new route
- `packages/mcp-server/src/tools.ts` — new `context_search` tool; `get_agent_session_context` gained `external_query`
- `packages/sdk/src/client.ts` + `index.ts` — `PimClient.searchContext()` method + pod-less `searchContext()` helper; `SessionContextOptions.externalQuery` + `SessionContext.externalContext`
- `packages/cli/src/index.ts` — registered the `search` command
- `packages/ui/src/router.tsx` + `services/api.ts` — `/search` route + `api.searchContext()`
- `packages/shared/src/index.ts` — re-exports the new types
- `docs/POD_AGENT_PROTOCOL.md` — documented the new `externalQuery` / `external_query` pull-step option
- `.env.example` — added the Context Search section

## Project scoping (onboarding)

Fan-out across all Jira projects / all GitHub orgs / all Slack workspaces is noisy for queries about a specific project ("has T3 Events completed their RBAC implementation?"). Each project can be **onboarded** with the external resources that define its surface area; every integration then narrows before searching.

### Resource shape

Stored as JSON in `projects.resources_json` (one column, migration-guarded):

```ts
interface ProjectResources {
  jira?: {
    project_keys?: string[];                // e.g. ["ADPINTAKE", "T3EV"]
    team?: string;                          // Jira "Team" custom field value (e.g. "Strata")
  };
  github?: { repos?: string[] };            // e.g. ["adobecom/t3-events"]
  slack?: { channels?: string[] };          // channel names, no '#'
  confluence?: { space_keys?: string[] };
  git?: { repo_paths?: string[] };          // absolute paths to local clones
  aliases?: string[];                       // synonyms — "Tier 3 Events", "T3EV"
}
```

### Onboarding

```bash
pim project create "T3 Events" \
  --jira MWPW \
  --jira-team Strata \
  --repos adobecom/EMC,adobecom/event-libs \
  --slack da-events-devs,da-events \
  --spaces adobedotcom \
  --alias "Tier 3 Events,T3,Events on Milo"

pim project show <project_id>
pim project set-resources <project_id> --jira ADPINTAKE,FOO --repos ...
```

MCP tools: `create_project({ name, resources })`, `configure_project_resources({ project_id, resources })`.
REST: `PUT /api/projects/:projectId/resources`.

### How it threads through search

`searchContext()` resolves project resources in this order:

1. **Explicit** `req.project_id`
2. **Pod-derived** `req.pod_id → pods.project_id`
3. **Query-text match** — `detectProjectFromQuery()` scans the query (word-boundary, case-insensitive) against every project's `name` + `aliases`. Longest match wins, so "T3 Events" beats "T3" when both are aliases on the same project.
4. **Explicit/query-detected actor** — `req.actor` or an email / Slack ID in the query text resolves to a `ContextSearchActor`. Doesn't set a project, but does count as a narrowing dimension for the Jira scope guard.
5. **IMS-authenticated user (last-resort fallback)** — if and only if steps 1–4 all produced no project and no actor **and** the query carries no `fixVersion` token (release queries like `T3-26.16` already satisfy the Jira guard and must not be silently narrowed to the caller, which would drop teammates' results), the orchestrator falls back to the request's authenticated user (taken from `req.user.email` by the route handler). It sets `scope.actor` to that user, unions every Jira project key from projects in the orgs they belong to (`users → memberships → projects.resources_json`) into `scope.project_resources.jira.project_keys`, and marks the result with `fallback: "authenticated_user"` so callers can explain the narrowing. **Important:** the fallback actor is passed *only* to the Jira integration. Slack, GitHub, Git, Confluence, Fluffyjaws, and KG receive `actor: undefined` in this case so a generic ad-hoc query like "milo block init" is not silently narrowed to the caller's own messages, commits, and PRs across those sources. The narrowing exists specifically to satisfy Jira's fail-closed scope guard, not to filter every source by the caller. Explicit and query-detected actors (step 4 above, and `req.actor`) still flow through to every source as before. **Synthesis** is also suppressed for the fallback actor — the LLM prompt's contract is "actor = all hits are filtered to this person", which would be wrong here since most sources weren't filtered (and the caller might even have excluded Jira from `sources`, in which case no source was filtered at all). The deterministic zero-hits branch is suppressed the same way: it returns `undefined` rather than "No matching activity found by *you*…". The response still echoes `scope.actor` and `fallback` so a caller-side surface can render them however it likes. The **cache key** also includes `scope.fallback`, so a query with the fallback and a query with the same explicit actor email don't collide on a single entry and poison each other.
6. Otherwise **unscoped** — Jira is skipped via `missing_sources`; other sources still run.

When the project is resolved via #3, the matched term is stripped from the query before integrations run (strict boundary — `(?<![\w\-.])TERM(?![\w\-.])` — so "T3" is stripped from "T3 events project" but **not** from "T3-26.16"). The cleaned query prevents the project name from over-constraining every integration's text-match clause.

Each integration then narrows:

| Integration | Query rewrite |
|---|---|
| Jira | Prepends `project in ("K1","K2")` and/or `"Team" = "X"` to JQL. Detects release tokens (e.g. `T3-26.16`, `v1.2.3`) in the query and emits `fixVersion in ("T3-26.16")` — bypassing the `updated` window since release tickets span months. |
| GitHub | Swaps env org-scope for `repo:X/Y repo:A/B`; falls back to orgs if no repos configured |
| Slack | Appends `in:#c1 in:#c2` to the search |
| Confluence | Prepends `space in ("K1")` to CQL |
| Fluffyjaws | Prefixes the user query with a one-line scope hint |
| Git | Iterates over `repo_paths` instead of the single `pods.repo_path` |

The orchestrator also gives each hit a `+2` relevance boost when it can prove the hit came from an in-scope resource (Jira key prefix, GitHub repo, Slack channel, Confluence space), and passes `project_scope` into the Haiku synthesis prompt so empty-result answers become "no activity in T3 Events for this query" rather than hedged "related tickets elsewhere".

### Person-scoped queries (identity resolver)

Queries like `"what has rea01581@adobe.com been up to"` or `"what has U02C5ESQM38 been up to"` used to text-match the identifier string. Now `packages/server/src/services/identity-resolver.ts` auto-detects emails and Slack user IDs in the query and resolves to a unified `{ email, slack_user_id, github_login, display_name }` via `slack.users.lookupByEmail`, `slack.users.info`, and GitHub user search. Results cache in the `identity_cache` SQLite table for 7 days.

When an `actor` is resolved (automatically or passed explicitly):

- **Jira** adds `(assignee = "email" OR reporter = "email" OR creator = "email")`
- **Slack** strips the identifier from the text query and adds `from:<@UXXX>`
- **GitHub** adds `author:<login>` on `/search/code` and `involves:<login>` on `/search/issues`
- **Git** adds `--author <email-or-name>` to the log invocation
- **Fluffyjaws / Confluence** pass the display name through to the prompt but don't narrow server-side (no authorship operator)

Project scope and actor compose: `project_id` + `actor` yields `project in (KEY) AND assignee = "email"` — "what has Rayyan shipped on T3 Events this sprint".

### Reporting

`sources_used` lists every source that ran without error, **including zero-hit runs** — so a caller can distinguish "Jira searched, nothing matched" from "Jira never ran". Errored sources go to `missing_sources` with the failure reason (truncated upstream body).

The response echoes `project_id`, `project_name`, and `actor` when scope was resolved (explicitly, from a pod, or detected from query text), so agents can surface the narrowing to the user ("searched within **T3 Events** scoped to commits by **Rayyan**…"). When the scope came from the IMS-authenticated-user fallback (resolution step 5), the response also sets `fallback: "authenticated_user"` so callers can word the narrowing differently ("searched as **you** across your orgs' Jira projects").

### Cache

The resolved project-resources fingerprint and actor are part of the cache key, so editing a project's resources invalidates its cached entries on the next query. Pre-onboarding broad-result caches do not shadow scoped queries.

## Adding a new source

1. Write `packages/server/src/integrations/<source>.ts` exporting `async function search<Source>(opts: IntegrationSearchOpts): Promise<IntegrationResult>`. Use `fetch`, respect `opts.query`, `opts.time_window_days`, `opts.max_hits_per_source`, `opts.pod_id`. Return `{source, hits: []}` when creds are missing — **never throw**.
2. Add the source to `ContextSource` in `packages/shared/src/types/context-search.ts` and to the `CONTEXT_SOURCES` array.
3. Wire it into `INTEGRATIONS` in `packages/server/src/services/context-search.ts` and give it an authority score in `sourceAuthority()`.
4. Extend the CLI `--sources` choices, the MCP tool's Zod enum, the UI's `SOURCE_LABELS`, and `.env.example`.
5. Document in this file.

## Deferred / v2

- **Microsoft Teams** — requires an Azure AD app registration with admin consent for `Chat.Read.All` / `ChannelMessage.Read.All`. Not a developer self-serve change at Adobe, and Adobe is Slack-first. Plumbed in shape only.
- **Remote MCP transport** — today's MCP is stdio-only. Hosted rollout adds an HTTP/SSE transport variant + IMS auth, so Claude Desktop users could point at `https://pim.adobe.internal/mcp` with no local setup. Nothing in v1 precludes this.
- **Per-user OAuth brokering** — v1 uses shared env tokens per source (same trust boundary as the Victor guide's Section 6). Hosted v2 swaps to AWS Secrets Manager + per-user IMS OAuth.
- **Pod repo path** — add a `repo_path` column to `pods`, wire `pim init` to capture it, and local git search immediately lights up.
- **Vector index** — if live fan-out latency becomes a problem, layer BM25 or embeddings over cached results. Not needed for v1.
- **Session auto-refresh for Fluffyjaws** — today, when the `fjv3_session` cookie rotates, the user has to re-run `fj login` and re-paste the session id into `.env`. A `pim fj-sync` helper (~20 lines) could read `~/.config/fj/session.json` and update `.env` in one step.

## Known quirks (captured from live testing)

These saved future maintainers a debugging cycle when we hit them:

- **Empty-string env values shadow defaults** with `??`. Use `||` for optional config strings that have sensible defaults (fixed in `fluffyjaws.ts`).
- **Atlassian on-prem vs. Cloud auth diverges.** On-prem uses Bearer PAT + REST v2; Cloud uses Basic + REST v3. We detect by hostname (`*.atlassian.net`).
- **Confluence on-prem rejects relative CQL dates** (`"-90d"`) — use an absolute `YYYY-MM-DD` cutoff computed server-side.
- **Fluffyjaws `reasoningEffort` wire values** are `none|minimal|low|medium|high|xhigh`, not the CLI-facing `fast|thinking`. The server auto-attaches `code_interpreter`, which rejects `minimal`, so `medium` is the practical minimum.
- **Slack bot tokens can't call `search.messages`** — that scope is user-only. Use `xoxp-…` tokens.
- **Slack granular `search:read.public` isn't honored by `search.messages`** — you'll see `missing_scope` even with the scope present. Grant the broader classic `search:read`; `slack.ts` filters results to public channels only (`is_private/is_im/is_mpim` dropped) so the effective privacy is the same.
- **Truncate error bodies** before putting them in `missing_sources.reason` — upstream services often return multi-KB HTML error pages that otherwise bloat the response payload.
