# Pod agent protocol (AI Council)

Every agent and human contributor working in a **pod** overseen by AI Council must follow this contract. Enforcement is via tooling (SDK, CLI, MCP, optional git hooks) and team discipline; the server does not cryptographically prove that a session “pulled first.”

## 1. Pull full context before substantive work

**When:** At the start of each work session, before implementing features, refactors, or spec-impacting changes.

**What to pull (single bundled operation):**

- Living doc (canonical pod markdown)
- Pod record (health, pressure, areas, milestone)
- All conflicts
- Token-budgeted relevant org learnings for your **scope**
- Recent context updates (for continuity)

**How:**

- **SDK:** `CouncilClient.pullSessionContext()` from `@council/sdk`
- **CLI:** `council context` (uses `COUNCIL_POD_ID`, `COUNCIL_AGENT_ID`, `COUNCIL_SCOPE`, `COUNCIL_SERVER_URL`)
- **MCP:** `get_agent_session_context` tool

**If conflict pressure is critical (≥ 0.8)** or ingestion is halted: stop and surface open conflicts; do not proceed with changes that add contested context until humans resolve blocking items.

## 2. Report after meaningful lock-in

**When:** After work is **locked in**—not after every keystroke.

Treat these as lock-in events:

- **Git commit** (including merge commits to an integration branch, if your team configures hooks accordingly)
- **Git revert** or history rewrite that undoes locked-in work (`post-rewrite` hook where applicable)
- Any other event your pod defines as irreversible (e.g. published artifact), if not using git

**What to send:** A structured **context update** via `CouncilClient.report()`, `council report`, MCP `submit_context_update`, or git hooks installed with `council hooks install`.

- Use `progress` for shipped increments; `spec_change` when the agreed surface changes; `decision` when a decision is recorded.
- Include **artifacts** with **repo-relative paths** when files changed.
- Summaries and details must stay free of secrets (ingestion scans apply).

## 3. Git hooks (optional)

Teams may run `council hooks install` so **post-commit** and **post-rewrite** submit a minimal progress update from the last commit metadata. Hooks read `COUNCIL_POD_ID`, `COUNCIL_AGENT_ID`, `COUNCIL_SCOPE`, and `COUNCIL_SERVER_URL`.

- Default: hooks **do not fail** the git operation if the Council API is down (`COUNCIL_HOOK_STRICT=0`).
- Set `COUNCIL_HOOK_STRICT=1` to fail the hook when reporting fails (stricter teams).

Amend and interactive rebase can produce multiple hook invocations; that is expected.

## 4. Session variables

| Variable | Purpose |
|----------|---------|
| `COUNCIL_SERVER_URL` | Council API base (default `http://localhost:4000`) |
| `COUNCIL_POD_ID` | Pod id for CLI/hooks |
| `COUNCIL_AGENT_ID` | Stable id for this agent or developer |
| `COUNCIL_SCOPE` | One of `frontend`, `backend`, `design`, `qa`, `infra`, `pm` |

See `.env.example` in the repo root.
