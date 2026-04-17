import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildArtifact } from "./artifact-template.js";
import { apiFetch, apiFetchText, apiPost, apiPut } from "./api.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/* ------------------------------------------------------------------ */
/*  Zod schemas (reusable fragments)                                  */
/* ------------------------------------------------------------------ */

const PodId = z.string().describe("Pod ID (e.g. 'pod-checkout-redesign')");
const ProjectId = z.string().describe("Project ID (e.g. 'project-demo')");
const Scope = z.enum(["frontend", "backend", "design", "qa", "infra", "pm"]);

/* ------------------------------------------------------------------ */
/*  Registration                                                      */
/* ------------------------------------------------------------------ */

export function registerTools(server: McpServer) {
  // ── existing read tools ──────────────────────────────────────────

  server.tool(
    "list_pods",
    "List all active pods in the organization. Returns pod IDs, names, day/total, pressure, open conflicts, and agent counts.",
    {},
    async () => {
      const pods = await apiFetch<unknown[]>("/api/org/pods");
      return json(pods);
    },
  );

  server.tool(
    "render_pod_dashboard",
    "Fetch all data for a pod and return a complete React component. Render the returned code as a React artifact to show the user an interactive pod dashboard with tabs for Dashboard, Conflicts, Feed, and Live Doc.",
    { pod_id: PodId },
    async ({ pod_id }) => {
      const [pod, conflicts, contextUpdates, livingDoc, tunnels, lintFindings] =
        await Promise.all([
          apiFetch(`/api/pods/${pod_id}`),
          apiFetch(`/api/pods/${pod_id}/conflicts`),
          apiFetch(`/api/pods/${pod_id}/context-updates`),
          apiFetchText(`/api/pods/${pod_id}/living-doc`),
          apiFetch(`/api/pods/${pod_id}/tunnels`),
          apiFetch(`/api/pods/${pod_id}/lint-findings`),
        ]);

      const artifact = buildArtifact({
        pod,
        conflicts,
        contextUpdates,
        livingDoc,
        tunnels,
        lintFindings,
        generatedAt: new Date().toISOString(),
      });

      return { content: [{ type: "text" as const, text: artifact }] };
    },
  );

  // ── pod lifecycle ────────────────────────────────────────────────

  server.tool(
    "create_pod",
    "Create a new pod (sprint). Returns the created pod with its generated ID and default areas.",
    {
      name: z.string().describe("Pod name (e.g. 'Checkout Redesign')"),
      sprint_days: z.number().optional().describe("Sprint length in days (default 5)"),
      milestone_name: z.string().optional().describe("Initial milestone name"),
    },
    async ({ name, sprint_days, milestone_name }) => {
      const pod = await apiPost("/api/pods", { name, sprint_days, milestone_name });
      return json(pod);
    },
  );

  server.tool(
    "archive_pod",
    "Archive a pod and extract knowledge learnings into the org knowledge graph. Returns the archived pod record and the number of learnings extracted.",
    { pod_id: PodId },
    async ({ pod_id }) => {
      const result = await apiPost(`/api/pods/${pod_id}/archive`);
      return json(result);
    },
  );

  // ── context updates ──────────────────────────────────────────────

  server.tool(
    "get_agent_session_context",
    "REQUIRED at the start of every work session (see docs/POD_AGENT_PROTOCOL.md): pull bundled PIM context in one call — living doc, pod state, conflicts, token-budgeted org learnings for the agent scope, and recent updates. Optionally include external context (Slack, Jira, Confluence, etc.) via external_query. Use before substantive coding. If conflict pressure is critical (>= 0.8), stop and address conflicts first.",
    {
      pod_id: PodId,
      agent_id: z.string().describe("Stable id for this agent or developer (echoed in response for tracing)"),
      scope: Scope,
      learnings_max_tokens: z.number().optional().describe("Token budget for relevant learnings (default 2000)"),
      recent_updates_limit: z.number().optional().describe("Max recent context updates to return (default 20)"),
      external_query: z
        .string()
        .optional()
        .describe("Optional query to also run through context_search (Slack/Jira/Confluence/GitHub/Fluffyjaws/git). Omit to skip external lookup."),
    },
    async ({ pod_id, agent_id, scope, learnings_max_tokens, recent_updates_limit, external_query }) => {
      const maxTok = learnings_max_tokens ?? 2000;
      const recentLimit = recent_updates_limit ?? 20;
      const scopes = encodeURIComponent(scope);

      const [living_doc_markdown, pod, conflicts, relevant_learnings, context_updates, external_context] =
        await Promise.all([
          apiFetchText(`/api/pods/${pod_id}/living-doc`),
          apiFetch(`/api/pods/${pod_id}`),
          apiFetch(`/api/pods/${pod_id}/conflicts`),
          apiFetch(`/api/knowledge/relevant?scopes=${scopes}&maxTokens=${maxTok}`),
          apiFetch(`/api/pods/${pod_id}/context-updates`),
          external_query
            ? apiPost("/api/context-search", { query: external_query, pod_id }).catch(() => null)
            : Promise.resolve(null),
        ]);

      const recent_updates = Array.isArray(context_updates)
        ? (context_updates as unknown[]).slice(0, recentLimit)
        : [];

      return json({
        pulled_at: new Date().toISOString(),
        agent_id,
        scope,
        living_doc_markdown,
        pod,
        conflicts,
        relevant_learnings,
        recent_updates,
        ...(external_context ? { external_context } : {}),
      });
    },
  );

  server.tool(
    "submit_context_update",
    "REQUIRED after meaningful lock-in work (commits, reverts, spec changes, decisions) per docs/POD_AGENT_PROTOCOL.md — submit progress, blockers, spec changes, questions, or decisions. Also use for manual reports when not using git hooks. Returns the created update and PIM analysis. Will be rejected (423) if the pod is in critical conflict state (pressure >= 0.8).",
    {
      pod_id: PodId,
      agent_id: z.string().describe("ID of the submitting agent or human"),
      type: z.enum(["progress", "blocker", "spec_change", "question", "decision"]),
      scope: Scope,
      summary: z.string().describe("One-line summary of the update"),
      details: z.string().describe("Full details of the update"),
      status: z.enum(["completed", "in_progress", "blocked"]),
      artifacts: z
        .array(z.object({
          type: z.string(),
          path: z.string().optional(),
          url: z.string().optional(),
        }))
        .optional()
        .describe("Attached artifacts (files, URLs)"),
      blocks: z.array(z.string()).optional().describe("IDs of agents/areas this blocks"),
      blocked_by: z.array(z.string()).optional().describe("IDs of agents/areas blocking this"),
      needs_input_from: z
        .array(z.object({ role: Scope, question: z.string() }))
        .optional()
        .describe("Input requests from other roles"),
    },
    async ({ pod_id, ...body }) => {
      const result = await apiPost(`/api/pods/${pod_id}/context-updates`, { ...body, source: "mcp" });
      return json(result);
    },
  );

  server.tool(
    "submit_project_context_update",
    "Submit a context update to a project (no active pod / between sprints). Same fields as pod updates; stored in project memory and does not run the full PIM orchestrator. High-signal types (decision, spec_change) may be added to the knowledge graph.",
    {
      project_id: ProjectId,
      agent_id: z.string().describe("ID of the submitting agent or human"),
      type: z.enum(["progress", "blocker", "spec_change", "question", "decision"]),
      scope: Scope,
      summary: z.string().describe("One-line summary of the update"),
      details: z.string().describe("Full details of the update"),
      status: z.enum(["completed", "in_progress", "blocked"]),
      artifacts: z
        .array(z.object({
          type: z.string(),
          path: z.string().optional(),
          url: z.string().optional(),
        }))
        .optional()
        .describe("Attached artifacts (files, URLs)"),
      blocks: z.array(z.string()).optional(),
      blocked_by: z.array(z.string()).optional(),
      needs_input_from: z
        .array(z.object({ role: Scope, question: z.string() }))
        .optional(),
    },
    async ({ project_id, ...body }) => {
      const result = await apiPost(`/api/projects/${project_id}/context-updates`, { ...body, source: "mcp" });
      return json(result);
    },
  );

  // ── conflict management ──────────────────────────────────────────

  server.tool(
    "get_conflict_details",
    "Get full details of a specific conflict including its sides, analysis, impact, and any downstream pending work that is blocked by it.",
    {
      pod_id: PodId,
      conflict_id: z.string().describe("Conflict ID"),
    },
    async ({ pod_id, conflict_id }) => {
      const [conflict, pendingWork] = await Promise.all([
        apiFetch(`/api/pods/${pod_id}/conflicts/${conflict_id}`),
        apiFetch(`/api/conflicts/${conflict_id}/pending-work`),
      ]);
      return json({ conflict, pending_work: pendingWork });
    },
  );

  server.tool(
    "resolve_conflict",
    "Resolve an open conflict. Triggers pressure recalculation, WebSocket broadcast, and Slack notification.",
    {
      pod_id: PodId,
      conflict_id: z.string().describe("Conflict ID to resolve"),
      resolution: z.string().describe("How the conflict was resolved"),
      resolved_by: z.string().describe("ID of the person or agent resolving it"),
    },
    async ({ pod_id, conflict_id, resolution, resolved_by }) => {
      const result = await apiPost(
        `/api/pods/${pod_id}/conflicts/${conflict_id}/resolve`,
        { resolution, resolved_by },
      );
      return json(result);
    },
  );

  // ── tunnel management ────────────────────────────────────────────

  server.tool(
    "create_tunnel",
    "Register a new dev tunnel for a pod. Creates a localhost tunnel entry so other team members can see the dev environment.",
    {
      pod_id: PodId,
      dev_name: z.string().describe("Developer name (e.g. 'alice')"),
      branch: z.string().describe("Git branch name"),
      port: z.number().describe("Local port number"),
    },
    async ({ pod_id, dev_name, branch, port }) => {
      const tunnel = await apiPost(`/api/pods/${pod_id}/tunnels`, {
        dev_name,
        branch,
        port,
      });
      return json(tunnel);
    },
  );

  server.tool(
    "disconnect_tunnel",
    "Disconnect an active tunnel.",
    {
      pod_id: PodId,
      tunnel_id: z.string().describe("Tunnel ID to disconnect"),
    },
    async ({ pod_id, tunnel_id }) => {
      const result = await apiPut(
        `/api/pods/${pod_id}/tunnels/${tunnel_id}/disconnect`,
      );
      return json(result);
    },
  );

  // ── knowledge graph ──────────────────────────────────────────────

  server.tool(
    "query_knowledge",
    "Search the org knowledge graph with token-budgeted results. Returns relevant learnings filtered by domain, type, confidence, and text search. Use this to find historical decisions, patterns, anti-patterns, and resolved conflicts.",
    {
      domains: z.array(z.string()).optional().describe("Filter by domain tags"),
      types: z
        .array(z.enum(["decision", "pattern", "anti_pattern", "resolved_conflict", "scope_insight"]))
        .optional()
        .describe("Filter by node type"),
      source_pod_ids: z.array(z.string()).optional().describe("Filter by source pod"),
      confidence_min: z.number().optional().describe("Minimum confidence score (0.0-1.0)"),
      curated_only: z.boolean().optional().describe("Only return human-curated nodes"),
      text_search: z.string().optional().describe("Full-text search query"),
      max_tokens: z.number().optional().describe("Token budget for results (default 2000)"),
      include_details: z.boolean().optional().describe("Include full node details"),
      limit: z.number().optional().describe("Max number of nodes to return"),
    },
    async (args) => {
      const { max_tokens, include_details, limit, ...filters } = args;
      const result = await apiPost("/api/knowledge/query", {
        filters,
        max_tokens,
        include_details,
        limit,
      });
      return json(result);
    },
  );

  // ── context search (cross-source external context) ──────────────

  server.tool(
    "context_search",
    "Search Adobe-internal context across Slack, Fluffyjaws, Jira, Confluence, GitHub, and local git. Returns a synthesized markdown summary with citations plus raw hits for drill-down. Use any time you need background on a topic — at session start, mid-debug, before writing a PR, or to resolve 'has anyone discussed X?' questions. Pod-agnostic: works with or without pod_id. Any source with missing credentials is silently skipped and reported in missing_sources.",
    {
      query: z.string().describe("Natural-language query or keywords"),
      sources: z
        .array(z.enum(["slack", "fluffyjaws", "jira", "confluence", "github", "git"]))
        .optional()
        .describe("Restrict to a subset of sources. Default: all configured."),
      pod_id: z
        .string()
        .optional()
        .describe("Optional — enables local git search for the pod's repo and biases ranking"),
      time_window_days: z.number().optional().describe("Default 90"),
      max_hits_per_source: z.number().optional().describe("Default 10"),
      synthesize: z.boolean().optional().describe("Default true. Set false to skip LLM summarization."),
      use_cache: z.boolean().optional().describe("Default true. Set false to force a fresh fan-out."),
    },
    async (input) => {
      const result = await apiPost("/api/context-search", input);
      return json(result);
    },
  );

  server.tool(
    "curate_knowledge_node",
    "Approve, reject, or edit a knowledge graph node. Human curation improves the quality of org knowledge that future pods query.",
    {
      node_id: z.string().describe("Knowledge node ID"),
      action: z.enum(["approve", "reject", "edit"]),
      edits: z
        .object({
          summary: z.string().optional(),
          details: z.string().optional(),
          domains: z.array(z.string()).optional(),
        })
        .optional()
        .describe("Edits to apply (required when action is 'edit')"),
    },
    async ({ node_id, action, edits }) => {
      const result = await apiPost(`/api/knowledge/nodes/${node_id}/curate`, {
        action,
        edits,
      });
      return json(result);
    },
  );

  // ── maintenance ──────────────────────────────────────────────────

  server.tool(
    "trigger_lint",
    "Run a lint pass on a pod. Returns any findings (consistency issues, stale blockers, missing inputs, etc.).",
    { pod_id: PodId },
    async ({ pod_id }) => {
      const result = await apiPost(`/api/pods/${pod_id}/lint`);
      return json(result);
    },
  );
}
