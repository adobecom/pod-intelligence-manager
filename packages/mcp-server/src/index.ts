#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

const server = new McpServer(
  { name: "pim", version: "0.1.0" },
  {
    instructions: `
You are connected to the PIM (Pod Intelligence Manager) MCP server. PIM is an orchestration layer for cross-functional AI+human pods (5-day sprints). It keeps every agent synchronized via a canonical living document, a knowledge graph of org learnings, and a conflict-pressure system.

## MANDATORY PROTOCOL

### Authentication (check before first tool call each session)
Call \`authenticate\` at the start of any session that will use PIM tools.
- If it returns \`status: "already_authenticated"\` or \`status: "trust_mode"\` — proceed immediately.
- If it returns \`needs_org_selection: true\` — call \`list_orgs\`, choose the correct org slug with the user, then call \`set_active_org(org_slug)\` before org-scoped tools.
- If it returns \`status: "pending"\` — show the user the \`auth_url\`, ask them to sign in, then call \`complete_authentication\`. Wait for confirmation before continuing.
- If any subsequent tool call returns a 401 or an error mentioning credentials — call \`authenticate\` again (the token may have expired mid-session) and repeat the flow.

### Before any substantive work
Call one of these — they are not optional:
- In a pod → call \`get_agent_session_context(pod_id, agent_id, scope)\`
- On a project (no pod) → call \`get_project_session_context(project_id, agent_id, scope)\`
- Neither → call \`query_knowledge\` with \`include_project_id\` set; without it, all project-tagged nodes across the org are visible (knowledge bleed)

### After every commit, revert, or spec change
- In a pod → call \`submit_context_update(pod_id, ...)\`
- On a project → call \`submit_project_context_update(project_id, ...)\`

### Conflict pressure gate
If the pod returned by \`get_agent_session_context\` has \`conflict_pressure >= 0.8\` (critical), stop substantive work and surface open conflicts. Intake is still accepted: \`submit_context_update\` returns **202** with \`queued: true\` (validation runs; PIM orchestration is deferred until pressure drops). Do not treat queued updates as merged into the living doc until conflicts are resolved.

---

## TOOLS

### Authentication
- \`authenticate\` — Start Adobe IMS OAuth sign-in. Returns an auth URL to open in the browser. If already signed in, returns immediately. Call this if any tool returns a 401 or "run pim login" error.
- \`complete_authentication\` — Finish sign-in after the user has visited the URL. Exchanges the code for tokens and writes \`~/.pim/credentials.json\`. Call this after the user confirms their browser shows "Signed in".
- \`list_orgs\` — Show available orgs and the org slug currently sent as \`X-Pim-Org\`.
- \`set_active_org\` — Persist the standalone MCP default org slug in \`~/.pim/config.json\`. \`PIM_ORG_SLUG\` and repo \`.pim.json\` override this default.

### Org & Projects
- \`get_org_config\` — read the org scope list (ids + labels). Call this before any tool that takes a scope id.
- \`update_org_config\` — full replacement of the org scope list.
- \`list_projects\` / \`get_project\` — enumerate or fetch a long-lived initiative.
- \`create_project\` — create an initiative. Pass \`resources\` (Jira keys, GitHub repos, Slack channels, Confluence spaces, git paths) upfront — this scopes all downstream \`context_search\` calls to that project's resources.
- \`configure_project_resources\` — replace the resource config for an existing project.
- \`update_project\` — patch name, description, or anatomy (internal scope slots + external collaborators).
- \`archive_project\` — detaches linked pods and stores a snapshot. Does NOT run pod knowledge extraction.

### Pod Lifecycle
- \`list_pods\` — all active pods with conflict pressure and open conflict counts.
- \`create_pod\` — start a new sprint. Optionally pass \`milestone_name\`.
- \`archive_pod\` — start sprint archival and background knowledge extraction.
- \`archive_pod_status\` — check archive completion/failure and fetch the archived pod record.
- \`render_pod_dashboard\` — returns a React artifact for interactive visualization of pod state.

### Session Context (MANDATORY — use before doing work)
- \`get_agent_session_context(pod_id, agent_id, scope, learnings_max_tokens?, recent_updates_limit?, task_query?, external_query?)\`
  Returns: living doc markdown, pod metadata, open conflicts, token-budgeted org learnings scoped to your pod/project, recent updates. Add \`external_query\` to also fan out to Slack/Jira/Confluence/GitHub/git in the same call.
- \`get_project_session_context(project_id, agent_id, scope, learnings_max_tokens?, recent_updates_limit?, task_query?, external_query?)\`
  Equivalent for between-sprint or project-level work. No living doc or conflicts — returns project metadata, recent project updates, and project-scoped learnings.

### Context Updates (MANDATORY after lock-in)
- \`submit_context_update(pod_id, agent_id, type, scope, summary, details, status, ...)\`
  Types: \`progress\` | \`blocker\` | \`spec_change\` | \`question\` | \`decision\`. At critical pressure (>= 0.8), returns **202** with \`queued: true\` (orchestration deferred, not rejected). High-signal types (decision, spec_change) are immediately added to the knowledge graph so concurrent pods see them.
- \`submit_project_context_update(project_id, ...)\` — same shape, stored in project memory. High-signal types may be added to the knowledge graph.

### Conflicts
- \`get_conflict_details(pod_id, conflict_id)\` — full conflict record including opposing sides, analysis, impact, and pending work at risk of rework.
- \`resolve_conflict(pod_id, conflict_id, resolution, resolved_by)\` — triggers pressure recalculation, WebSocket broadcast, and Slack notification. Immediately adds a \`resolved_conflict\` node to the knowledge graph.

### Tunnels
- \`create_tunnel(pod_id, dev_name, branch, port)\` — register a localhost dev tunnel for a pod member.
- \`disconnect_tunnel(pod_id, tunnel_id)\` — manually disconnect a tunnel. Idle tunnels are NOT auto-disconnected — only heartbeat failure disconnects them.

### Knowledge Graph
- \`query_knowledge(domains?, types?, include_project_id?, text_search?, query_text?, max_tokens?, ...)\`
  Token-budgeted search across org learnings (decisions, patterns, anti-patterns, resolved conflicts, scope insights). IMPORTANT: always pass \`include_project_id\` when the caller has a known project — without it, nodes from all projects are returned. \`query_text\` uses semantic (embedding) scoring; \`text_search\` is a substring filter.
- \`curate_knowledge_node(node_id, action, edits?)\` — approve, reject, or edit a knowledge node. Human curation improves quality for future pods.

### External Context Search
- \`context_search(query, sources?, pod_id?, project_id?, actor?, ...)\`
  Fan-out across Slack, Jira, Confluence, GitHub, Fluffyjaws, and local git. Pod/project agnostic — works with or without a pod. Pass \`project_id\` to scope to configured project resources (dramatically improves precision). Pass \`actor\` (email/Slack ID/GitHub login) to filter hits to a specific person. Returns a synthesized markdown summary plus raw hits. Sources without credentials are silently skipped and listed under \`missing_sources\`.

### Pod State Updates
- \`update_pod_milestone(pod_id, name?, target_date?, percent_complete?)\` — update milestone name, target date, and/or completion percentage. At least one field required. Triggers a living doc regeneration.
- \`link_pod_to_project(pod_id, project_id)\` — associate or disassociate a pod with a project. Linking gates knowledge scoping and \`context_search\` precision to that project's resources. Pass \`null\` to unlink.

### Maintenance
- \`trigger_lint(pod_id)\` — run a consistency/staleness lint pass on a pod. Returns findings (stale blockers, missing inputs, etc.).
- \`get_pod_quality_stats(pod_id)\` — fetch agent quality metrics: update counts, type breakdown, status distribution, agent contribution stats. Useful for PM/QA scope agents.

---

## RESOURCES (read-only URIs)

Org-level:
- \`pim://org/pods\` — all active pod summaries (id, name, pressure, conflicts, agents)
- \`pim://org/overlaps\` — cross-pod overlap advisories
- \`pim://org/archived\` — archived pods with final pressure
- \`pim://org/archived-projects\` — archived initiatives with anatomy snapshots
- \`pim://org/config\` — org scope definitions
- \`pim://org/projects\` — all active projects

Pod-scoped:
- \`pim://pods/{pod_id}\` — pod metadata, areas, milestone, pressure
- \`pim://pods/{pod_id}/living-doc\` — living document markdown
- \`pim://pods/{pod_id}/conflicts\` — full conflict list
- \`pim://pods/{pod_id}/context-updates\` — update feed
- \`pim://pods/{pod_id}/tunnels\` — active dev tunnels
- \`pim://pods/{pod_id}/lint-findings\` — lint issues

Project-scoped:
- \`pim://projects/{project_id}\` — project metadata and anatomy

Knowledge graph:
- \`pim://knowledge/graph\` — full graph (nodes, edges, communities) — may be large
- \`pim://knowledge/stats\` — node/edge counts, top domains

---

## PROMPTS (pre-assembled briefings — call these for richer guidance)

- \`session_context(pod_id, scope?)\` — richest onboarding prompt; assembles all pod context with embedded conflict-pressure warnings and scope responsibilities. Prefer this over raw \`get_agent_session_context\` when you want a fully formatted briefing.
- \`standup_report(pod_id)\` — team standup from recent activity, open conflicts, and milestone state.
- \`conflict_resolution_guide(pod_id, conflict_id)\` — structured resolution recommendation with historical precedents from the knowledge graph.
- \`pod_health_check(pod_id)\` — green/yellow/red health assessment with actionable recommendations.
- \`knowledge_search(query, domains?)\` — synthesized summary of org learnings with patterns, anti-patterns, and gaps.
- \`sprint_kickoff(name, sprint_days?, focus_areas?)\` — kickoff briefing drawing on past pod learnings and archived pod history.
- \`pod_retrospective(pod_id)\` — retro generation before archival; highlights learnings worth extracting to the knowledge graph.
`.trim(),
  },
);

registerTools(server);
registerResources(server);
registerPrompts(server);

const transport = new StdioServerTransport();
await server.connect(transport);
