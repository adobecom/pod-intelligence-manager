# Pod agent protocol (PIM)

Every agent and human contributor working in a **pod** overseen by PIM must follow this contract. Enforcement is via tooling (SDK, CLI, MCP, optional git hooks) and team discipline; the server does not cryptographically prove that a session “pulled first.”

## 1. Pull full context before substantive work

**When:** At the start of each work session, before implementing features, refactors, or spec-impacting changes.

**What to pull (single bundled operation):**

- Living doc (canonical pod markdown)
- Pod record (health, pressure, areas, milestone)
- All conflicts
- Token-budgeted relevant org learnings for your **scope**
- Recent context updates (for continuity)

**How:**

- **SDK:** `PimClient.pullSessionContext()` from `@pim/sdk`
- **CLI:** `pim context` (uses `PIM_POD_ID`, `PIM_AGENT_ID`, `PIM_SCOPE`, `PIM_SERVER_URL`)
- **MCP:** `get_agent_session_context` tool

**If conflict pressure is critical (≥ 0.8):** stop substantive work and surface open conflicts. Context intake still succeeds (HTTP 202, `queued: true`); PIM orchestration is deferred until pressure drops. Do not rely on queued updates being merged into the living doc until blocking conflicts are resolved.

**Optional — external context:** `pullSessionContext({ externalQuery })` (SDK) or the `external_query` argument on the MCP `get_agent_session_context` tool uses that task-specific text to sharpen KG learning retrieval and adds a cross-source lookup (Slack, Jira, Confluence, GitHub, Fluffyjaws, local git) to the same bundle. Use this when the work depends on context that is not yet in the living doc — e.g. "pay endpoint failing" or the name of a feature you are picking up mid-stream. See [Context Search](#5-context-search-on-demand) below.

## 2. Report after meaningful lock-in

**When:** After work is **locked in**—not after every keystroke.

Treat these as lock-in events:

- **Git commit** (including merge commits to an integration branch, if your team configures hooks accordingly)
- **Git revert** or history rewrite that undoes locked-in work (`post-rewrite` hook where applicable)
- Any other event your pod defines as irreversible (e.g. published artifact), if not using git

**What to send:** A structured **context update** via `PimClient.report()`, `pim report`, MCP `submit_context_update`, or git hooks installed with `pim hooks install`.

- Use `progress` for shipped increments; `spec_change` when the agreed surface changes; `decision` when a decision is recorded.
- Include **artifacts** with **repo-relative paths** when files changed.
- Summaries and details must stay free of secrets (ingestion scans apply).

## 3. Git hooks (optional)

Teams may run `pim hooks install` so **post-commit** and **post-rewrite** submit a minimal progress update from the last commit metadata. Hooks read `PIM_POD_ID`, `PIM_AGENT_ID`, `PIM_SCOPE`, and `PIM_SERVER_URL`.

- Default: hooks **do not fail** the git operation if the PIM API is down (`PIM_HOOK_STRICT=0`).
- Set `PIM_HOOK_STRICT=1` to fail the hook when reporting fails (stricter teams).

Amend and interactive rebase can produce multiple hook invocations; that is expected.

### LLM-enriched submissions

The hook always submits `type: progress` with the raw commit subject as `summary` — no API key or special config required on the developer's machine. The PIM **server** asynchronously enriches the record after it lands, using its own Bedrock/Claude access (Haiku).

The server-side enrichment reads the stored commit subject, body, and stat, then rewrites:

| Field | Initial (from hook) | After enrichment |
|---|---|---|
| `type` | `progress` | Inferred: `progress` / `spec_change` / `decision` / `blocker` / `question` |
| `summary` | Raw commit subject (≤500 chars) | PIM-quality summary ≤200 chars, past tense, with context |
| `status` | `completed` | Inferred: `completed` / `in_progress` / `blocked` |
| `blocks` | `[]` | Extracted from commit body if mentioned |
| `blocked_by` | `[]` | Extracted from commit body if mentioned |
| `needs_input_from` | `[]` | Extracted if commit body raises a question |

Enrichment is non-blocking — the HTTP response returns before it runs, and if the LLM call fails the original record is left unchanged. The UI receives a `context_update_enriched` WebSocket event when enrichment completes.

**Commit message guidance:** Write commit messages normally. The commit body is the highest-signal input for type inference — if you record a decision or flag a blocker there, it will be classified correctly. You do not need to follow any special format.

## 4. Session variables

| Variable | Purpose |
|----------|---------|
| `PIM_SERVER_URL` | PIM API base (hosted: `https://d1ygncl0yqo6sv.cloudfront.net`; local dev: `http://localhost:4000`) |
| `PIM_POD_ID` | Pod id for CLI/hooks |
| `PIM_AGENT_ID` | Stable id for this agent or developer |
| `PIM_SCOPE` | An org-defined scope id from `get_org_config` / `GET /api/org/config` |

See `.env.example` in the repo root.

## 5. Context search (on demand)

External context (Slack, Fluffyjaws, Jira, Confluence, GitHub, local git) is available any time via:

- **SDK:** `PimClient.searchContext(query, opts?)` or the pod-less `searchContext(baseUrl, request)` helper.
- **CLI:** `pim search "query"` (no pod id required).
- **MCP:** `context_search` tool.

All calls hit `POST /api/context-search` on the PIM server. Sources without credentials configured are silently skipped and listed under `missing_sources`. Results are cached (default 1h TTL, keyed by normalized query + filters) and run through secret redaction before being returned or synthesized.

### Project and actor scoping

Both `searchContext()` and the `/api/context-search` route accept two optional scoping inputs that dramatically improve result precision:

- `project_id` — scopes Jira to configured project keys + Team, GitHub to configured repos, Slack to configured channels, Confluence to configured space keys, and local git to configured repo paths. Configure these once via `pim project create` or the `create_project` / `configure_project_resources` MCP tools.
- `actor` — filters hits to a specific person (`email`, `slack_user_id`, `github_login`, or `display_name`). Usually auto-detected from query phrases like `"what has rea01581@adobe.com been up to"`, but can be passed explicitly.

Project detection also runs from query text (project name or any configured alias, word-boundary match, longest wins). Release tokens like `T3-26.16` are extracted and emitted as a Jira `fixVersion` clause; the default time window is skipped when `fixVersion` is set.

The response echoes `project_id`, `project_name`, and `actor` so agents can surface the narrowing to the user ("searched within **T3 Events**, scoped to **Rayyan**…").
