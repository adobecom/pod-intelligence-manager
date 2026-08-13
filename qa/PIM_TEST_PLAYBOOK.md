# PIM Test Playbook (reproducible)

> **Historical live-QA record (2026-06-03).** Exact pass counts, observed bugs, routes, org data,
> and deployment state below describe that run and may no longer be current. Use the root README,
> `docs/README.md`, and package test scripts for current validation; retain this file only for the
> original reproduction evidence.

This records what was run on 2026-06-03, in what order, and which check found each issue.

> Convention: a check FAILS only when actual behavior contradicts the documented contract. Tag every artifact you create with a run marker (for example `QA-<area>-<date>`) so it is identifiable and cleanable.

---

## 0. Setup and preconditions

1. **Pick the target.** Deployed system: `https://d1ygncl0yqo6sv.cloudfront.net`. Confirm it is up and which build:
   ```bash
   curl -s https://d1ygncl0yqo6sv.cloudfront.net/api/health
   # expect {"status":"ok", ..., "db":{"connected":true,"active_pods":N}}
   ```
   `uptime_seconds` tells you how recently the origin restarted (use it to confirm a fresh deploy of the code under test). No local server runs by default (`:4000` server, `:5173` UI).

2. **Auth and org.** The user signs in once via Adobe IMS; credentials live at `~/.pim/credentials.json`.
   - MCP: call `mcp__ai-council__authenticate` (returns `already_authenticated` if signed in). MCP tools are deferred; load them first with `ToolSearch` using `select:<tool>,<tool>` queries.
   - Set the working org (this persists to `~/.pim/config.json`; note the prior value and restore it at the end):
     `mcp__ai-council__set_active_org { org_slug: "ado" }`
   - REST: use the on-disk token plus an explicit org header:
     ```bash
     TOKEN=$(jq -r .access_token ~/.pim/credentials.json)
     AUTH=(-H "Authorization: Bearer $TOKEN" -H "X-Pim-Org: ado" -H "Content-Type: application/json")
     BASE=https://d1ygncl0yqo6sv.cloudfront.net
     # On 401, re-run mcp__ai-council__authenticate to refresh, then re-read TOKEN.
     ```
   - Token validity: check `expires_at` (epoch ms) in the credentials file; on 2026-06-03 it had roughly 6 hours left.

3. **Valid scopes** (org config drives everything): `mcp__ai-council__get_org_config` returned `frontend, backend, design, qa, infra, pm` for `ado`.

4. **Route map ground truth** (read these to avoid guessing paths; not all are guessable, for example `GET /api/pods` 404s):
   - Routes registered in `packages/server/src/index.ts`.
   - Agent memory contracts: `packages/server/src/routes/agent-memory.ts`.
   - KG query/submit contracts: `packages/server/src/routes/graph.ts`.
   - Context-update ingestion: `packages/server/src/routes/context-updates.ts` and `packages/server/src/services/ingestion.ts`.
   - Memory enrichment internals: `packages/server/src/services/memory-enrichment.ts`.

---

## 1. Reconnaissance (do this first)

- `git show <merge-commit> --stat` and read the commit body to enumerate feature areas to test.
- Read the route files above to capture exact paths, status codes, and validation.
- `mcp__ai-council__list_pods` and `mcp__ai-council__list_projects` to see existing data (do not mutate it).

---

## 2. Workstream A: Pod lifecycle (MCP) [run directly, sequential]

1. `create_pod { name, milestone_name, sprint_days: 5 }` -> capture `POD`.
2. `get_agent_session_context { pod_id: POD, agent_id: "qa-orchestrator", scope: "backend" }` -> baseline. Confirms living-doc assembly on an empty pod and shows token-budgeted org learnings. Inspect the `relevant_learnings.nodes[]` for the new #72 fields: `retrieval_tier`, `retention_score`, `retrieval_count`, `entity_refs`, `retrieval_text`, `embedding_text_hash`, and `query_mode` echoed.
3. Populate. Submit updates across scopes via `submit_context_update`. To exercise the conflict agent, include two directly contradictory backend `decision`s (for example "Adopt Redis for the session cache" and "Use Memcached; do not use Redis"). Use distinct `agent_id`s, vary `type` (progress/decision/blocker/question via `needs_input_from`), attach `artifacts`, and set `blocks` / `blocked_by`.
4. Re-pull `get_agent_session_context` -> verify the Context Stream, Decisions Log, per-area owner/status, milestone percent, and Knowledge Context populate. Each `submit_context_update` response also returns `pim` analysis (`classification`, `merged`, `conflictCreated`, `scout_used`) and `quality_score`.
5. `trigger_lint { pod_id: POD }` -> expect deterministic findings (for example multiple agents per area) plus an LLM pass (`meta.bedrock_configured: true`, `llm_extra_findings`). Verify the LLM finding set includes the contradiction.
6. `update_pod_milestone { pod_id: POD, percent_complete, name }` -> 200, triggers living-doc regen.
7. `get_pod_quality_stats { pod_id: POD }` -> per-agent update_count plus avg/min/max quality.
8. (If a conflict was created) `get_conflict_details` then `resolve_conflict`. NOTE: blocked by BUG-1 (no conflict is created), so this step is currently un-runnable.
9. `render_pod_dashboard { pod_id: POD }` -> returns a React component bundling the pod data.
10. `archive_pod { pod_id: POD }` -> roll-up. Expect knowledge extraction. SEE BUG-2: this may return a CloudFront 504 while still succeeding on the origin.
11. Verify the roll-up actually happened (even if the client got a 504):
    - `list_pods` (pod gone from active),
    - `curl "$BASE/api/org/archived" "${AUTH[@]}"` (pod present),
    - `query_knowledge { source_pod_ids: [POD], confidence_min: 0, include_details: true, max_tokens: 3000 }` (extracted nodes present, with graded confidence, `community_id`, `entity_refs`).

---

## 3. Workstream B: Agent Memory System REST E2E [#72 headline; REST only]

All paths under `$BASE`. Capture ids into shell vars.
1. `POST /api/agent-sessions` (agent_id, scope, goal, working_state) -> 201, capture `SID`.
2. `POST /api/agent-sessions` with no `agent_id` -> 400.
3. `POST /api/agent-sessions` with a bogus `pod_id` -> 404 "Project or pod not found".
4. `GET /api/agent-sessions/$SID` -> 200; unknown -> 404.
5. `PATCH /api/agent-sessions/$SID/working-state` `{working_state:{step:1}, merge:true}` -> merged; then `{working_state:{only:"x"}}` (no merge) -> replaced.
6. `POST /api/agent-sessions/$SID/runs` -> 201, capture `RID`.
7. `POST /api/agent-runs/$RID/events` x4 (tool_call, tool_result, model_output, file_change), no `expected_seq` -> 201 each, seq 1..4.
8. `POST .../events` `{expected_seq:5}` -> 201; `{expected_seq:999}` -> 409 with `expected_seq:6`; `{event_type:"bogus"}` -> 400; to unknown run -> 404.
9. `POST /api/agent-sessions/$SID/checkpoints` `{snapshot:{...}}` -> 201.
10. `GET /api/agent-sessions/$SID/timeline` -> 200 (runs + events + checkpoints).
11. `GET /api/agent-sessions/$SID/resume-context` -> 200, verify the bundle fields. `event_limit=0|101|abc` -> 400; `event_limit=5` -> 200.
12. `PATCH /api/agent-runs/$RID/end` `{status:"completed", final_output:"<substantive learning>", token_*}` -> 200, creates a pending MemoryCandidate.
13. `POST .../events` to the ended run -> 409 with `status`.
14. `GET /api/agent-sessions/$SID/memory-candidates` -> >=1 pending; `?status=pending` -> 200; `?status=bogus` -> 400.
15. `POST /api/agent-sessions/$SID/rollup` -> 200.
16. `POST /api/memory-candidates/$CID/promote` -> 200; then confirm it landed in the KG via `POST /api/knowledge/query {query_text:"<candidate words>", filters:{confidence_min:0}}`.
17. `POST /api/memory-candidates/$CID2/reject` -> 200; reject again -> 200 (idempotent). Promote/reject unknown -> 404.
18. Compaction: fresh session + run, append 55 small events, then `GET` the session/timeline; verify `compacted_summary` and `last_compacted_event_rowid` populate. (SEE BUG-5: no `run_compacted` event is emitted.)
19. Cross-org: `GET /api/agent-sessions/$SID` with `-H "X-Pim-Org: emc-sandbox"` -> 404. With NO `X-Pim-Org` -> 200 (falls back to first org; SEE BUG-7).
20. `POST /api/agent-sessions/$SID/end` -> 200, status ended.

---

## 4. Workstream C: KG retrieval + temporal/tiering/identifier [#72]

1. `GET /api/knowledge/stats` -> baseline counts.
2. `POST /api/knowledge/nodes` with a structured identifier in the text (for example "QaProbeTokenRotator") -> 200, capture `NODE`.
3. Submit the same node again -> 409 near-duplicate.
4. Quality-gate probe: submit gibberish (`"aaaaaaaaaa"` / `"aaaa..."`) -> EXPECT 422. (SEE BUG-3: returns 200.)
5. Identifier index: `POST /api/knowledge/query {query_text:"QaProbeTokenRotator", include_details:true, filters:{confidence_min:0}}` -> NODE returned; confirm each hit has `retrieval_tier` and `entity_refs`.
6. Semantic paraphrase query (no identifier) -> NODE still surfaces via embedding.
7. Filters: `types`, `domains`, `curated_only:true` (excludes uncurated NODE), `confidence_min:0.8` (excludes a 0.7 node), `retrieval_tiers:["hot"]` vs `["cold"]`.
8. Temporal modes (with `query_text` + `confidence_min:0`):
   - `query_mode:"current"` -> echoed.
   - `query_mode:"history"` -> count vs current.
   - `query_mode:"as_of", as_of:"<future ISO>"` -> includes a just-created node; `as_of:"2020-01-01T00:00:00Z"` -> excludes it.
   - `query_mode:"as_of"` with no `as_of` -> 400; with `as_of:"not-a-date"` -> 400.
   - `query_mode:"why_changed"` -> 200, `edges` present (include_edges forced).
9. `expand_graph:false` vs `true` on a text query -> compare counts (needs a graph with edges to show a difference).
10. `max_tokens:60` vs `3000` -> confirm budget truncation (needs a populated graph).
11. `GET /api/knowledge/relevant?scopes=backend&query=...` and `GET /api/knowledge/precedents?conflict=...` -> 200.
12. MCP parity: `query_knowledge` vs the REST query for the same text. (SEE BUG-8: MCP token_estimate differs because it always sets include_details.)
13. MCP `context_search {query, sources:["kg"], synthesize:true}` -> synthesized summary plus citations; check `missing_sources`.

---

## 5. Workstream D: Projects / context-search / tunnels / misc REST

1. `list_projects`; `create_project` with `resources` -> capture `PROJECT`.
2. `get_project`, `get_project_profile` -> resources persisted.
3. `get_project_session_context {project_id, agent_id, scope}` -> bundle.
4. `submit_project_context_update` then re-fetch session context -> update appears.
5. `update_project`, `patch_project_profile`, `add_project_resource_binding` then `remove_project_resource_binding`, `configure_project_resources` (SEE OBS: full replace drops unspecified fields).
6. `link_pod_to_project` (additive).
7. `archive_project` (cleanup) -> gone from active, in `/api/org/archived-projects`, linked pod detached.
8. `context_search {sources:["kg"], synthesize:true, use_cache:false}`; also with `project_id` for scoping.
9. `create_tunnel` then `disconnect_tunnel`.
10. Misc safe GETs (read the route files for exact paths): `/api/health`, `/api/pods/:id`, `/api/pods/:id/living-doc`, `/api/pods/:id/living-doc/stats`, `/api/pods/:id/conflicts`, `/api/pods/:id/tunnels`, `/api/pods/:id/lint-findings`, `/api/org/config`, `/api/org/pods`, `/api/org/overlaps`, `/api/org/archived`, `/api/org/archived-projects`, `/api/org/tuning`, `/api/org/tuning/history`, `/api/me`, `/api/orgs`, `/api/orgs/:slug`, `/api/orgs/:slug/members`.

---

## 6. Workstream E: White-box (build + typecheck + tests) [local repo]

Repo: `/Users/rkhan/ai-council/ai-council` (pnpm workspaces, vitest). Do not modify source or git state.
1. Check `node_modules` exists at root and in `packages/server`; install only if missing (`pnpm install --frozen-lockfile`; if it fails on Artifactory/registry auth, that is an environment blocker, not a code bug).
2. Typecheck: `pnpm --filter @pim/server typecheck`.
3. Run the suites #72 added/changed individually: `services/__tests__/agent-memory.test.ts`, `__tests__/integration.test.ts`, `db/__tests__/connection.test.ts`, `integrations/__tests__/kg.test.ts`, `services/__tests__/knowledge-graph-query.test.ts`, `services/__tests__/knowledge-graph-org-isolation.test.ts`, `services/__tests__/project-memory.test.ts`, `services/__tests__/embeddings.test.ts`, and `packages/cli/src/__tests__/shared-standards.test.ts`. Then the full server suite for regressions.
4. Eval wiring: confirm `packages/eval/src/tasks/index.ts` imports and adds `memoryCurrentVsStale` and `memoryWhyChanged` to `ALL_TASKS` (a file that exists but is not in the array is silently excluded).
5. Do NOT run the evals themselves (they need Bedrock).

Result on 2026-06-03: 372/372 tests pass (server 360, CLI 12), typecheck clean, both eval tasks wired. Node v24.1.0, pnpm v10.33.0.

---

## 7. Bug-to-test traceability matrix (the key reference)

| Bug | Severity | The exact test/step that caught it | Expected vs Actual |
|---|---|---|---|
| BUG-1: 500 on a 2nd update to a scope that already has a `decision`; blocks conflict creation; persists row then 500s (duplicate on retry) | HIGH | Workstream A step 3 (submit a contradictory pair of backend decisions) plus the A/B discriminators: submit a 2nd update to a scope whose 1st was a `decision` (backend, design) -> 500; submit a 2nd update to a scope whose 1st was `progress` (frontend) -> 201. Confirm by re-pulling `get_agent_session_context`: both decisions appear in the Decisions Log but Open Conflicts is None and pressure is 0, and the 500'd rows are still present in `recent_updates`. | Expected 201 + conflict created at pressure > 0; Actual 500, row persisted, no conflict, duplicate on retry. |
| BUG-2: `archive_pod` returns CloudFront 504 though archival succeeds | MEDIUM | Workstream A step 10 (`archive_pod`) then step 11 verification (pod gone from `list_pods`, present in `/api/org/archived`, 13 nodes in `query_knowledge {source_pod_ids:[POD]}`). | Expected a 2xx with the archived record + learning count; Actual 504 to client, success on origin. |
| BUG-3: KG quality gate accepts garbage | MEDIUM | Workstream C step 4 (`POST /api/knowledge/nodes` with low-entropy gibberish). | Expected 422; Actual 200, node created (`kn-d8b1a562`). |
| BUG-4: no-body POST rejects `Content-Type: application/json` empty body | MEDIUM | Workstream B step 15 (`POST .../rollup` with the header and no body). Same on `.../end`, promote, reject. | Expected 200; Actual 400 "Body cannot be empty...". |
| BUG-5: no `run_compacted` event emitted on compaction | LOW | Workstream B step 18 (append 55 events, inspect timeline). | Expected a `run_compacted` timeline marker; Actual only `compacted_summary` fields set. |
| BUG-6: auto-promote (>0.85) unreachable via run-end | LOW | Workstream B step 12 + reading `AGENT_RUN_CONFIDENCE_CAP` (0.7) in `services/agent-memory.ts`. | Expected reachable `auto_promoted`; Actual capped at 0.7, so only manual promote works. |
| BUG-7: missing `X-Pim-Org` falls back to first org | LOW | Workstream B step 19 (GET a session with no org header). | Expected 400/explicit; Actual 200 from the user's first org. |
| BUG-8: MCP `query_knowledge` token_estimate diverges from REST | LOW | Workstream C step 12 (MCP vs REST same query). | Expected parity or documented difference; Actual MCP always sets include_details. |
| OBS: `configure_project_resources` full replace drops unspecified fields | LOW | Workstream D step 5 (patch profile to add aliases, then configure without them). | Documented behavior; aliases silently dropped. |

Green (worked, no bug): everything in Workstream E (372/372); agent-memory 24/25; KG temporal/tiering/identifier/as_of-validation/dedup 22/24; projects/search/tunnels/misc 18/18; lint LLM pass; knowledge extraction at archival (13 nodes); merge agent; living-doc assembly and regen.

---

## 8. Cleanup

- Archived pods stay in `/api/org/archived` by design (the roll-up is the deliverable).
- Uncurated KG nodes (confidence < 0.5, uncurated, older than 180 days) auto-prune; to remove sooner, curate/reject in the `/knowledge` UI or `POST /api/knowledge/nodes/:id/curate {action:"reject"}`.
- Disconnect any tunnels and archive any throwaway projects you created.
- Restore the saved active org: `set_active_org { org_slug: "<original>" }` (this run restored `emc-sandbox`).

---

## 9. Coverage gaps to pick up next

1. Conflict resolution flow (`get_conflict_details`, `resolve_conflict`) once BUG-1 is fixed.
2. `render_pod_dashboard` on a live pod.
3. `expand_graph` one-hop and `max_tokens` truncation against a now-populated `ado` graph (13+ nodes, one community).
4. WebSocket real-time and the tunnel proxy with a live client.
5. Auto-promote >0.85, superseded-node temporal behavior, and source-authority ranking deltas (need richer seeded data).
