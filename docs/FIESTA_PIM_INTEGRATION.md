# fiesta × PIM Integration — Implementation Guide

This document prescribes the full set of changes required to wire the `fiesta`
harness into PIM (pod-intelligence-manager / ai-council). Apply each section in
order; every change is isolated and non-breaking — if no pod/project binding is
configured the harness runs exactly as before.

---

## What this integration does

| Direction | What | Where |
|---|---|---|
| **Read** | Pulls living doc + token-budgeted org learnings + open conflicts + conflict pressure at run start | `src/nodes/pim.py` → `state.pim_learnings` |
| **Gate** | Halts before `codegen`/`close` if pod conflict pressure ≥ 0.8 | `src/nodes/orchestrator.py` `validate_route` |
| **Write** | Reports PR-opened (lock-in event) to pod | `src/graphs/close.py` `open_pr_node` |
| **Write** | Reports merge outcome to pod | `src/graphs/close.py` `finalize_close` |
| **Write** | Submits post-merge KG learning (ad-hoc, enters curation queue) | `src/graphs/close.py` `finalize_close` |

Binding (which pod/project an issue maps to) is resolved at intake from config
YAML and env var overrides; no binding → PIM is silently skipped for that run.

---

## 1. Fix three wire-format bugs in `packages/memory/pim_client.py`

These are blocking: `report()` would silently misread conflict pressure, `submit_learning()` would get HTTP 422s, and `pull_session_context()` would call an endpoint that doesn't exist.

### 1a. `submit_learning` — wrong field names

**Find** (lines ~197-203):
```python
body: dict[str, Any] = {
    "nodeType": node_type,
    "summary": summary[:500],
    "details": details,
    "domains": domains,
    "scope": self._scope,
    "source_label": source_label,
}
```

**Replace with:**
```python
body: dict[str, Any] = {
    "type": node_type,           # was "nodeType" — PIM expects "type"
    "summary": summary[:500],    # 10-500 chars enforced by server
    "details": details,          # ≥30 chars enforced by server
    "domains": domains,          # ≥1 domain required
    "scopes": [self._scope],     # was "scope" (str) — PIM expects "scopes" (list)
    "source_label": source_label,
}
```

**Why:** `AdHocLearningInput` in `packages/shared/src/types/graph.ts:229` and the Zod schema in `packages/server/src/routes/graph.ts:71-118` expect `type` (not `nodeType`) and `scopes` (string array, not a string).

---

### 1b. `report()` — conflict pressure detection dead

**Find** (inside `report()`, the block that raises `PodConflictPressureError`):
```python
if resp.status_code == 423:
    raise PodConflictPressureError(
        pod_id=self._pod_id,
        detail=resp.text[:200],
    )
resp.raise_for_status()
return resp.json()
```

**Replace with:**
```python
if resp.status_code == 202:
    data = resp.json()
    if data.get("queued"):
        raise PodConflictPressureError(
            pod_id=self._pod_id,
            detail=data.get("message", f"pressure={data.get('conflict_pressure', '?')}"),
        )
resp.raise_for_status()
return resp.json()
```

**Why:** PIM never returns 423. On critical pod pressure the context-updates POST returns HTTP 202 with `{queued: true, conflict_pressure: <float>, message: "..."}` (verified against `packages/server/src/routes/context-updates.ts:99-121`).

---

### 1c. `pull_session_context()` — calls an endpoint that doesn't exist + rewrite as parallel GETs

PIM has no `/api/pods/{id}/session-context` endpoint. Context is assembled
client-side (mirrors the `get_agent_session_context` MCP tool in
`packages/mcp-server/src/tools.ts:379-442`).

**Replace the entire `pull_session_context` method with:**

```python
async def pull_session_context(
    self,
    opts: SessionContextOptions | None = None,
) -> SessionContext:
    """Bundled context for one work session.

    Mirrors get_agent_session_context MCP tool (tools.ts:379-442) — assembles
    context client-side via parallel GETs since PIM has no bundled
    /session-context server endpoint.

    Returns: living doc + pod state + conflicts + token-budgeted learnings +
    recent updates + optional external context (when external_query provided).
    Call ONCE at run start; cache in HarnessState.pim_learnings.
    """
    assert self._pod_id, "pull_session_context requires a pod-scoped client"
    opts = opts or {}
    max_tokens = opts.get("learnings_max_tokens", 2000)
    recent_limit = opts.get("recent_update_limit", 20)
    task_query = (opts.get("external_query") or "").strip() or None

    async with httpx.AsyncClient(headers=self._headers, timeout=30) as client:
        # Pod first — need project_id to scope learnings (prevents cross-project bleed)
        pod_resp = await client.get(f"{self._base_url}/api/pods/{self._pod_id}")
        pod_resp.raise_for_status()
        pod: dict[str, Any] = pod_resp.json()
        project_id: str | None = pod.get("project_id")

        # Build learnings query string
        qs_parts = [
            f"scopes={urllib.parse.quote(self._scope)}",
            f"maxTokens={max_tokens}",
        ]
        if project_id:
            qs_parts.append(f"projectId={urllib.parse.quote(str(project_id))}")
        if task_query:
            qs_parts.append(f"taskQuery={urllib.parse.quote(task_query)}")
        learnings_url = f"{self._base_url}/api/knowledge/relevant?{'&'.join(qs_parts)}"

        # Parallel fetches (mirrors MCP tool Promise.all)
        coros: list[Any] = [
            client.get(f"{self._base_url}/api/pods/{self._pod_id}/living-doc"),
            client.get(f"{self._base_url}/api/pods/{self._pod_id}/conflicts"),
            client.get(learnings_url),
            client.get(f"{self._base_url}/api/pods/{self._pod_id}/context-updates"),
        ]
        if task_query:
            coros.append(
                client.post(
                    f"{self._base_url}/api/context-search",
                    json={"query": task_query, "pod_id": self._pod_id},
                )
            )

        responses: list[Any] = await asyncio.gather(*coros, return_exceptions=True)

    # Unpack and parse defensively — any single fetch failure is non-blocking
    living_doc_resp = responses[0]
    conflicts_resp = responses[1]
    learnings_resp = responses[2]
    updates_resp = responses[3]
    search_resp = responses[4] if task_query and len(responses) > 4 else None

    living_doc_markdown: str | None = None
    if not isinstance(living_doc_resp, Exception):
        try:
            living_doc_resp.raise_for_status()
            living_doc_markdown = living_doc_resp.text
        except Exception:
            pass

    conflicts: list[Any] = []
    if not isinstance(conflicts_resp, Exception):
        try:
            conflicts_resp.raise_for_status()
            conflicts = conflicts_resp.json()
        except Exception:
            pass

    relevant_learnings: dict[str, Any] = {"nodes": [], "token_count": 0}
    if not isinstance(learnings_resp, Exception):
        try:
            learnings_resp.raise_for_status()
            relevant_learnings = learnings_resp.json()
        except Exception:
            pass

    recent_updates: list[Any] = []
    if not isinstance(updates_resp, Exception):
        try:
            updates_resp.raise_for_status()
            all_updates = updates_resp.json()
            recent_updates = (all_updates if isinstance(all_updates, list) else [])[:recent_limit]
        except Exception:
            pass

    external_context: dict[str, Any] | None = None
    if search_resp is not None and not isinstance(search_resp, Exception):
        try:
            search_resp.raise_for_status()
            external_context = search_resp.json()
        except Exception:
            pass

    return SessionContext(
        pulled_at="",
        pod=pod,
        living_doc_markdown=living_doc_markdown,
        conflicts=conflicts,
        relevant_learnings=relevant_learnings,
        recent_updates=recent_updates,
        external_context=external_context,
    )
```

Also add `import urllib.parse` to the imports at the top of the file if not already present, and add `import asyncio` if not already present.

**Also update `from_env()`** — the current signature omits the `project_id` and `org_slug` that the constructor expects. Replace the entire `from_env` classmethod with:

```python
@classmethod
def from_env(cls, pod_id: str | None = None, scope: str | None = None) -> "PimClient":
    """Create a pod-scoped client from env vars.

    scope: overrides HARNESS_TENANT — use state["pim_scope"] when available
    so context updates land in the correct pod area (e.g. "frontend" not "acom").
    """
    return cls(
        base_url=os.environ.get("PIM_API_URL", "http://localhost:4000"),
        agent_id="acom-harness",
        scope=scope or os.environ.get("HARNESS_TENANT", "acom"),
        pod_id=pod_id,
        org_slug=os.environ.get("PIM_ORG_SLUG", "acom"),
        auth_token=os.environ.get("PIM_API_KEY"),
    )
```

The updated module docstring (replace the existing one at the top):

```python
"""PIM HTTP client — implements the PIM SDK protocol in Python.

Source/reference: pod-intelligence-manager-main/packages/sdk/src/client.ts

PIM runs as its own service (Fastify :4000, DynamoDB+S3 in prod).
In V1 we call via HTTP; in V2 we can switch to the MCP surface without
changing the HarnessState or node interfaces.

Session protocol (use in this order per POD_AGENT_PROTOCOL.md):
  1. pull_session_context()  — bundled context at run start
  2. report()                — submit progress/blockers during work
  3. submit_learning()       — post-merge knowledge submission (fire-and-forget)

PIM filtering discipline (CRITICAL):
  Only use high-durability (≥ 0.7), high-confidence (≥ 0.6), domain-matched
  learnings. Loading all nodes into a plan dropped pass rate 100% → 50%
  in PIM's own negative-control eval. The learnings_max_tokens parameter
  enforces a hard token budget.

Implementation notes — wire format corrections verified against PIM server source:
  - pull_session_context: PIM has NO /api/pods/{id}/session-context endpoint.
    Context is assembled client-side from parallel GETs (mirrors get_agent_session_context
    MCP tool in packages/mcp-server/src/tools.ts:379-442).
  - report: critical conflict pressure returns HTTP 202 {queued:true}, NOT 423.
  - submit_learning: field is "type" (not "nodeType"); scope is "scopes" (list, not str).
"""
```

---

## 2. Add two fields to `src/models/state.py`

Inside `HarnessState`, after the existing `pod_id` field, add:

```python
    pod_id: Optional[str]
    # PIM project id — used when pod_id is absent (long-lived projects vs sprints).
    # Resolved at intake by src/services/pim_binding.py.
    project_id: Optional[str]
    # PIM scope/area (e.g. "frontend", "backend") that identifies this agent's lane
    # in the pod. Resolved at intake; defaults to HARNESS_TENANT.
    pim_scope: Optional[str]
```

(If `pod_id` already exists without `project_id` / `pim_scope` beneath it, insert the two new fields immediately after it.)

---

## 3. Create `src/services/__init__.py` (new file)

Create this file as **empty** (zero bytes, or a single blank line). It marks
`src/services/` as a Python package so `from src.services.pim_binding import ...`
resolves correctly.

---

## 4. Create `src/services/pim_binding.py` (new file, complete content)

```python
"""PIM pod/project binding resolver.

Resolves which PIM pod_id or project_id this harness run belongs to, and
which scope/area the harness agent should self-identify as within that pod.

Resolution order (highest wins):
  1. Env vars: PIM_POD_ID, PIM_PROJECT_ID, PIM_SCOPE
  2. Repo-level config: config/repos/<repo>.yaml  → pim.pod_id / pim.project_id / pim.scope
  3. Tenant-level config: config/tenants/<tenant>.yaml → pim.pod_id / pim.project_id / pim.scope

Non-fatal design: if no binding is found, all three keys are None and the
harness silently skips PIM (same as today). Call from intake before building
the initial HarnessState.

Usage:
    from src.services.pim_binding import resolve_pim_binding

    binding = resolve_pim_binding(repo="acom/fe", tenant="acom")
    input_state.update(binding)  # adds pod_id / project_id / pim_scope
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

# Default config root — matches FileProvider in src/config/providers.py
_CONFIG_ROOT = Path(os.environ.get("HARNESS_CONFIG_ROOT", "config"))


def _load_yaml(path: Path) -> dict[str, Any]:
    """Return parsed YAML mapping or {} on any error (fail-open)."""
    try:
        text = path.read_text()
    except (FileNotFoundError, OSError):
        return {}
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        logger.warning("Ignoring malformed PIM binding YAML: %s", path)
        return {}
    return data if isinstance(data, dict) else {}


def _pim_section(d: dict[str, Any]) -> dict[str, Any]:
    pim = d.get("pim")
    return pim if isinstance(pim, dict) else {}


def resolve_pim_binding(
    repo: str,
    tenant: str,
    config_root: Path | str | None = None,
) -> dict[str, Any]:
    """Return dict with pod_id, project_id, pim_scope (any may be None).

    These keys map directly onto the HarnessState fields of the same name
    (see src/models/state.py). Callers merge the result into input_state:

        input_state.update(resolve_pim_binding(repo=..., tenant=...))

    The dict always has all three keys (with None as the absent sentinel) so
    callers don't have to guard for KeyError.
    """
    root = Path(config_root) if config_root else _CONFIG_ROOT

    # Layer 1: tenant config (lowest precedence)
    tenant_cfg = _pim_section(_load_yaml(root / "tenants" / f"{tenant}.yaml"))

    # Layer 2: repo config (overrides tenant; repo path uses __ for /)
    safe_repo = repo.replace("/", "__")
    repo_cfg = _pim_section(_load_yaml(root / "repos" / f"{safe_repo}.yaml"))

    # Merge layers low → high (repo wins over tenant)
    pod_id: str | None = repo_cfg.get("pod_id") or tenant_cfg.get("pod_id")
    project_id: str | None = repo_cfg.get("project_id") or tenant_cfg.get("project_id")
    pim_scope: str | None = repo_cfg.get("scope") or tenant_cfg.get("scope")

    # Layer 3: env vars (highest precedence — process-level override)
    pod_id = os.environ.get("PIM_POD_ID") or pod_id
    project_id = os.environ.get("PIM_PROJECT_ID") or project_id
    pim_scope = os.environ.get("PIM_SCOPE") or pim_scope or tenant

    if pod_id or project_id:
        logger.debug(
            "PIM binding resolved: pod_id=%s project_id=%s scope=%s",
            pod_id, project_id, pim_scope,
        )
    else:
        logger.debug("PIM binding: no pod_id or project_id found — PIM disabled for this run")

    return {
        "pod_id": pod_id,
        "project_id": project_id,
        "pim_scope": pim_scope,
    }
```

---

## 5. Wire the binding into `apps/gateway/dispatch.py`

### 5a. Add the import

At the top of the file, alongside the other `src.*` imports, add:

```python
from src.services.pim_binding import resolve_pim_binding
```

### 5b. Call it at intake and spread into `input_state`

Find the block inside `handle_intake` that builds `input_state` (the dict passed
to the LangGraph run). It currently looks roughly like:

```python
    repo = resolve_repo(event.body)
    tenant = os.environ.get("HARNESS_TENANT", "acom")

    input_state = {
        "issue_id": _issue_id(event),
        "issue_title": event.title,
        "issue_body": event.body,
        "repo": repo,
        "tenant": tenant,
    }
```

**Replace with:**

```python
    repo = resolve_repo(event.body)
    tenant = os.environ.get("HARNESS_TENANT", "acom")
    pim_binding = resolve_pim_binding(repo=repo, tenant=tenant)

    input_state = {
        "issue_id": _issue_id(event),
        "issue_title": event.title,
        "issue_body": event.body,
        "repo": repo,
        "tenant": tenant,
        **pim_binding,   # pod_id, project_id, pim_scope
    }
```

---

## 6. Rewrite `src/nodes/pim.py` (complete replacement)

Replace the entire file with:

```python
"""PIM node — pulls session context from the Pod Intelligence Manager.

Called once at run start as part of the knowledge_gather fan-out
(src/graphs/planner.py). Result is cached in HarnessState.pim_learnings.

Binding resolution:
  - pod_id present:     pull_session_context() — full bundle (living doc, conflicts,
                        learnings, recent updates, conflict pressure)
  - project_id only:    get_relevant_learnings() — learnings only, project-scoped
  - neither:            skip PIM (non-fatal); pim_learnings populated with empty shell

PIM filtering discipline (CRITICAL): learnings_max_tokens=2000 enforces the
hard token budget. Loading all nodes dropped pass rate 100% → 50% in PIM's
negative-control eval. Do NOT raise this without consulting the PIM team.

external_query: passes the issue title+body to PIM so the knowledge/relevant
endpoint returns semantically-ranked learnings instead of keyword-only results.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from src.models.state import HarnessState

logger = logging.getLogger(__name__)

_LEARNINGS_MAX_TOKENS = 2000
_RECENT_UPDATE_LIMIT = 20


def _empty_learnings(pod_id: str | None, project_id: str | None, scope: str) -> dict[str, Any]:
    return {
        "pod_id": pod_id,
        "project_id": project_id,
        "scope": scope,
        "session_context": {},
        "relevant_learnings": [],
        "living_doc": None,
        "conflicts": [],
        "recent_updates": [],
    }


def _external_query(state: HarnessState) -> str | None:
    """Build a task-specific query from the issue so PIM returns semantic learnings."""
    title = (state.get("issue_title") or "").strip()
    body = (state.get("issue_body") or "").strip()
    # 500 chars is sufficient signal; the embedding model doesn't benefit from more
    combined = f"{title} {body[:480]}".strip()
    return combined if combined else None


async def run(state: HarnessState) -> dict[str, Any]:
    pod_id = state.get("pod_id")
    project_id = state.get("project_id")
    pim_scope = state.get("pim_scope") or state.get("tenant") or "unknown"

    if not pod_id and not project_id:
        logger.info("PIM skipped — no pod_id or project_id in state; running without pod context")
        return {
            "pim_learnings": _empty_learnings(pod_id, project_id, pim_scope),
            "agent_execution_order": ["pim"],
        }

    ext_query = _external_query(state)

    try:
        from packages.memory.pim_client import PimClient

        if pod_id:
            # Full session context — living doc, conflicts, pressure, learnings
            client = PimClient.from_env(pod_id=pod_id, scope=pim_scope)
            session_ctx = await client.pull_session_context(
                opts={
                    "learnings_max_tokens": _LEARNINGS_MAX_TOKENS,
                    "recent_update_limit": _RECENT_UPDATE_LIMIT,
                    "external_query": ext_query,
                }
            )
            relevant = session_ctx.get("relevant_learnings") or {}
            learnings = {
                "pod_id": pod_id,
                "project_id": project_id,
                "scope": pim_scope,
                "session_context": session_ctx.get("pod") or {},
                "relevant_learnings": relevant.get("nodes", []),
                "living_doc": session_ctx.get("living_doc_markdown"),
                "conflicts": session_ctx.get("conflicts", []),
                "recent_updates": session_ctx.get("recent_updates", []),
            }
        else:
            # Project-scoped — learnings only (no living doc, no conflicts)
            client = PimClient(
                base_url=os.environ.get("PIM_API_URL", "http://localhost:4000"),
                agent_id="acom-harness",
                scope=pim_scope,
                project_id=project_id,
                org_slug=os.environ.get("PIM_ORG_SLUG", "acom"),
                auth_token=os.environ.get("PIM_API_KEY"),
            )
            result = await client.get_relevant_learnings(max_tokens=_LEARNINGS_MAX_TOKENS)
            learnings = {
                "pod_id": pod_id,
                "project_id": project_id,
                "scope": pim_scope,
                "session_context": {},
                "relevant_learnings": result.get("nodes", []),
                "living_doc": None,
                "conflicts": [],
                "recent_updates": [],
            }
    except Exception as exc:
        logger.warning("PIM context pull failed (non-blocking): %s", exc)
        learnings = _empty_learnings(pod_id, project_id, pim_scope)

    return {
        "pim_learnings": learnings,
        "agent_execution_order": ["pim"],
    }
```

---

## 7. Add conflict-pressure gate to `src/nodes/orchestrator.py`

### 7a. Add two module-level constants

After the existing `DEFAULT_WORKFLOW_BUDGET_USD` constant, add:

```python
# PIM conflict pressure threshold at which the harness pauses rather than
# charging into irreversible work (codegen / close). Mirrors PIM's own gate at
# packages/server/src/routes/context-updates.ts:101 (orgTuning.pressure.degradedMax).
# Check PIM org tuning for the canonical value; 0.8 is the documented default.
_PIM_CRITICAL_PRESSURE = float(os.environ.get("HARNESS_PIM_PRESSURE_GATE", "0.8"))

# Phases where we should honour the pressure gate — the ones that make
# irreversible changes (write code, open a PR). Reading and planning are
# informational; the pressure check protects against committing into a
# contested state.
_PRESSURE_GATED_PHASES = {"codegen", "close"}
```

### 7b. Add the pressure gate inside `validate_route`

Find the block that checks `_goal_satisfied` (goal check → return completed):

```python
    # Goal satisfied -> success.
    if _goal_satisfied(state):
        return {
            "_route_target": "finalize",
            "workflow_status": "completed",
            "route_hops": hops + 1,
            "agent_execution_order": ["validate_route:goal"],
        }
```

**After that block, insert:**

```python
    # PIM conflict-pressure gate: before entering irreversible phases (codegen /
    # close), check whether the pod is under critical pressure. At >= 0.8 PIM
    # queues (not outright rejects) new context updates, meaning the pod's
    # conflicts are unresolved enough that further autonomous work risks
    # widening them. Pause the run so the team can resolve conflicts first.
    if proposed in _PRESSURE_GATED_PHASES and state.get("pod_id"):
        pim_learnings = state.get("pim_learnings") or {}
        session_ctx = pim_learnings.get("session_context") or {}
        pressure = float(session_ctx.get("conflict_pressure") or 0.0)
        if pressure >= _PIM_CRITICAL_PRESSURE:
            return {
                "_route_target": "finalize",
                "workflow_status": "failed",
                "workflow_error": (
                    f"PIM pod conflict pressure is critical ({pressure:.2f} ≥ "
                    f"{_PIM_CRITICAL_PRESSURE}). Resolve open pod conflicts before "
                    f"proceeding into {proposed}. Check the pod dashboard at "
                    f"{os.environ.get('PIM_API_URL', 'http://localhost:4000')}."
                ),
                "route_hops": hops + 1,
                "agent_execution_order": [f"validate_route:pim_pressure_halt:{pressure:.2f}"],
            }
```

---

## 8. Add PIM write-back to `src/graphs/close.py`

### 8a. Add two async helper functions

After the module docstring and imports (before the `# ── Close graph nodes` section),
insert:

```python
# ── PIM write-back helpers ────────────────────────────────────────────────────

async def _pim_report_pr_opened(state: HarnessState) -> None:
    """Fire-and-forget: report PR-opened to PIM pod (lock-in event)."""
    pod_id = state.get("pod_id")
    if not pod_id:
        return
    try:
        from packages.memory.pim_client import PimClient
        pim_scope = state.get("pim_scope") or state.get("tenant") or "backend"
        client = PimClient.from_env(pod_id=pod_id, scope=pim_scope)
        files = list(state.get("codegen_files_changed") or state.get("files_changed") or [])
        pr_url = state.get("pr_url", "")
        await client.report({
            "type": "progress",
            "summary": f"PR opened: {_pr_title(state)}",
            "details": (
                f"Issue {state.get('issue_id', '?')}: automated change ready for review.\n"
                f"PR: {pr_url}\n"
                f"Files: {', '.join(files[:10]) or '(none)'}"
            ),
            "artifacts": [{"type": "pr", "url": pr_url}] if pr_url else [],
        })
        logger.debug("PIM: reported PR opened for pod %s", pod_id)
    except Exception as exc:  # includes PodConflictPressureError — queued is fine
        logger.warning("PIM report(pr_opened) failed (non-blocking): %s", exc)


async def _pim_finalize_write_back(state: HarnessState) -> None:
    """Fire-and-forget: report merge outcome + submit KG learning (merge_approved only)."""
    pod_id = state.get("pod_id")
    if not pod_id:
        return
    try:
        from packages.memory.pim_client import PimClient
        pim_scope = state.get("pim_scope") or state.get("tenant") or "backend"
        client = PimClient.from_env(pod_id=pod_id, scope=pim_scope)
        merge_approved = state.get("merge_approved", False)
        issue_id = state.get("issue_id", "unknown")
        pr_url = state.get("pr_url") or ""

        # Report completion/abandonment regardless of merge outcome
        summary = (
            f"Merge approved: {_pr_title(state)}"
            if merge_approved
            else f"Run closed (no merge): {_pr_title(state)}"
        )
        try:
            await client.report({
                "type": "progress",
                "summary": summary,
                "details": (
                    f"Issue {issue_id} {'merged' if merge_approved else 'closed without merge'}."
                    f"{' PR: ' + pr_url if pr_url else ''}"
                ),
            })
        except Exception as exc:
            # Inner catch: KG submission should proceed even if report() fails.
            logger.warning("PIM report(finalize) failed (non-blocking): %s", exc)

        if not merge_approved:
            return

        # Post-merge KG learning — ad-hoc path (CLAUDE.md: "do not add a third")
        spec = state.get("spec") or {}
        files = list(state.get("codegen_files_changed") or state.get("files_changed") or [])
        issue_title = state.get("issue_title") or ""
        repo = state.get("repo") or ""

        kg_summary = (
            spec.get("problem_summary")
            or spec.get("summary")
            or issue_title
            or f"Automated change for {issue_id}"
        )[:490]

        details_parts = [f"Issue: {issue_id}"]
        if pr_url:
            details_parts.append(f"PR: {pr_url}")
        if files:
            details_parts.append(f"Files changed: {', '.join(files[:10])}")
        if spec.get("approach"):
            details_parts.append(f"Approach: {str(spec['approach'])[:300]}")
        kg_details = ". ".join(details_parts)
        if len(kg_details) < 30:
            kg_details = f"Automated change {issue_id} merged via acom-harness. {kg_details}"

        # Domains: scope + repo leaf (e.g. "acom-fe")
        domains: list[str] = [pim_scope]
        repo_leaf = repo.rsplit("/", 1)[-1] if repo else ""
        if repo_leaf and repo_leaf != pim_scope:
            domains.append(repo_leaf)
        domains = list(dict.fromkeys(d.lower() for d in domains if d))[:3]

        node_type = "decision" if spec.get("approach") else "pattern"
        await client.submit_learning(
            node_type=node_type,
            summary=kg_summary,
            details=kg_details,
            domains=domains,
        )
        logger.info("PIM: submitted post-merge KG learning for issue %s", issue_id)

    except Exception as exc:
        logger.warning("PIM finalize write-back failed (non-blocking): %s", exc)
```

> **Note on the nested try/except:** the inner `try/except` around `client.report()` is intentional. It lets the KG `submit_learning()` call proceed even when `report()` raises (e.g. `PodConflictPressureError` on high pressure). The outer catch is the overall non-blocking safety net.

> **Note on local imports:** `from packages.memory.pim_client import PimClient` is inside the function body intentionally. `close.py` must load in environments where `packages.memory` is absent (test isolation). Module-level imports would break those tests.

---

### 8b. Call `_pim_report_pr_opened` from `open_pr_node`

Find the end of `open_pr_node` where it builds the `partial` dict and returns it:

```python
    partial: dict[str, Any] = {
        "pr_url": result.pr_url,
        "branch_name": result.branch,
        "files_changed": files_changed,
        "close_status": "pr_open",
        "agent_execution_order": ["close.open_pr"],
    }
    return partial
```

**Replace with:**

```python
    partial: dict[str, Any] = {
        "pr_url": result.pr_url,
        "branch_name": result.branch,
        "files_changed": files_changed,
        "close_status": "pr_open",
        "agent_execution_order": ["close.open_pr"],
    }
    # PIM lock-in report — fire-and-forget after state is ready to read
    await _pim_report_pr_opened({**state, **partial})
    return partial
```

---

### 8c. Make `finalize_close` async and add write-back

Find:

```python
def finalize_close(state: HarnessState) -> dict[str, Any]:
    return {"agent_execution_order": ["close.finalize"]}
```

**Replace with:**

```python
async def finalize_close(state: HarnessState) -> dict[str, Any]:
    # PIM write-back: report outcome + submit KG learning on merge (fire-and-forget)
    await _pim_finalize_write_back(state)
    return {"agent_execution_order": ["close.finalize"]}
```

LangGraph supports `async` node functions natively; no graph registration change needed.

---

## 9. Update `config/README.md`

Append the following section at the end of the file (or after the existing "Env overrides" section):

```markdown
## PIM pod/project binding

The `pim:` stanza wires a repo or tenant to a PIM pod or project so context is
pulled (and written back) automatically. Resolved by `src/services/pim_binding.py`
at intake; env vars `PIM_POD_ID`, `PIM_PROJECT_ID`, `PIM_SCOPE` override files.

```yaml
# config/tenants/<tenant>.yaml  — org-wide project
pim:
  project_id: proj-acom-abc123
  scope: frontend

# config/repos/<repo>.yaml  — sprint-specific pod (overrides tenant)
pim:
  pod_id: pod-acom-fe-2026q3-sprint1
  scope: frontend
```

`pod_id` takes precedence: enables the full bundle (living doc, conflicts,
conflict-pressure gate). `project_id` alone gives learnings-only context.
`scope` identifies the agent's area in the pod (e.g. "frontend", "backend").
Defaults to `HARNESS_TENANT` env var when unset.
```

---

## 10. Environment variables (deployment)

Add these to wherever fiesta's env is configured (ECS task def, `.env`, etc.):

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PIM_API_URL` | Yes (for PIM to work) | `http://localhost:4000` | PIM server base URL |
| `PIM_API_KEY` | If PIM auth is enabled | _(none)_ | Bearer token for `Authorization` header |
| `PIM_ORG_SLUG` | Recommended | `acom` | Sent as `X-Pim-Org` header |
| `PIM_POD_ID` | Optional | _(none)_ | Process-level override for pod binding |
| `PIM_PROJECT_ID` | Optional | _(none)_ | Process-level override for project binding |
| `PIM_SCOPE` | Optional | `HARNESS_TENANT` | Process-level override for pod scope/area |
| `HARNESS_PIM_PRESSURE_GATE` | Optional | `0.8` | Float threshold for conflict-pressure halt |

If `PIM_API_URL` is not set and `PIM_POD_ID`/`PIM_PROJECT_ID` are also not set,
PIM is silently skipped for every run — zero runtime impact.

---

## 11. Activate a binding

To start using PIM for a specific repo, create `config/repos/<org>__<repo>.yaml`
(replace `/` with `__` in the repo path):

```yaml
# config/repos/acom__fe.yaml
pim:
  pod_id: pod-emc-webhook-integration-84aa08   # example — use your actual pod
  scope: frontend
```

Or set `PIM_POD_ID=<pod-id>` in the environment for a process-level override
(useful for testing or one-off deployments).

---

## Checklist

- [ ] `packages/memory/pim_client.py` — three bug fixes applied (§1a, §1b, §1c)
- [ ] `src/models/state.py` — `project_id` + `pim_scope` fields added (§2)
- [ ] `src/services/__init__.py` — empty file created (§3)
- [ ] `src/services/pim_binding.py` — new file created (§4)
- [ ] `apps/gateway/dispatch.py` — import + `pim_binding` spread added (§5)
- [ ] `src/nodes/pim.py` — file replaced (§6)
- [ ] `src/nodes/orchestrator.py` — constants + pressure gate added (§7)
- [ ] `src/graphs/close.py` — two helpers + `open_pr_node` call + async `finalize_close` (§8)
- [ ] `config/README.md` — PIM stanza docs added (§9)
- [ ] Env vars configured in deployment (§10)
- [ ] At least one binding configured in config YAML or env var (§11)
