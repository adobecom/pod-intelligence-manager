import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiFetch, apiFetchText, apiPost } from "./api.js";

/* ------------------------------------------------------------------ */
/*  Types (lightweight — only what prompts need)                      */
/* ------------------------------------------------------------------ */

interface Pod {
  pod_id: string;
  name: string;
  sprint_start: string;
  sprint_end: string;
  day_number: number;
  total_days: number;
  conflict_pressure: number;
  milestone: { name: string; target_date: string; percent_complete: number };
  areas: Array<{ scope: string; owner: string; status: string; last_activity: string | null }>;
}

interface Conflict {
  id: string;
  status: string;
  severity: string;
  summary: string;
  sides: Array<{ contributor: string; position: string }>;
  master_analysis: string;
  impact: string[];
  resolved_by: string | null;
  resolution: string | null;
}

interface ContextUpdate {
  id: string;
  agent_id: string;
  timestamp: string;
  type: string;
  scope: string;
  summary: string;
  status: string;
}

interface PendingWork {
  context_update_id: string;
  agent_id: string;
  summary: string;
  presumes: string;
  rework_cost: string;
}

interface KnowledgeQueryResult {
  nodes: Array<{ id: string; type: string; summary: string; details: string; domains: string[] }>;
  total_matching: number;
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function userMsg(text: string) {
  return {
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
}

/* ------------------------------------------------------------------ */
/*  Registration                                                      */
/* ------------------------------------------------------------------ */

export function registerPrompts(server: McpServer) {
  // ── standup report ───────────────────────────────────────────────

  server.prompt(
    "standup_report",
    "Generate a standup report for a pod based on recent activity, open conflicts, and current pressure.",
    { pod_id: z.string().describe("Pod ID") },
    async ({ pod_id }) => {
      const [pod, updates, conflicts] = await Promise.all([
        apiFetch<Pod>(`/api/pods/${pod_id}`),
        apiFetch<ContextUpdate[]>(`/api/pods/${pod_id}/context-updates`),
        apiFetch<Conflict[]>(`/api/pods/${pod_id}/conflicts`),
      ]);

      const recent = updates.slice(0, 15);
      const openConflicts = conflicts.filter((c) => c.status !== "resolved");

      return userMsg(`Generate a concise standup report for pod "${pod.name}".

## Pod State
- Day ${pod.day_number} of ${pod.total_days}
- Conflict pressure: ${pod.conflict_pressure}
- Milestone: ${pod.milestone.name} (${pod.milestone.percent_complete}% complete, target ${pod.milestone.target_date})

## Areas
${pod.areas.map((a) => `- **${a.scope}** (${a.owner}): ${a.status}${a.last_activity ? ` — last active ${a.last_activity}` : ""}`).join("\n")}

## Recent Activity (last ${recent.length} updates)
${recent.map((u) => `- [${u.type}/${u.scope}] ${u.summary} (${u.agent_id}, ${u.status})`).join("\n")}

## Open Conflicts (${openConflicts.length})
${openConflicts.length === 0 ? "None" : openConflicts.map((c) => `- [${c.severity}] ${c.summary}`).join("\n")}

Format as a team-friendly standup with: what was done, what's in progress, what's blocked, and any conflicts needing attention.`);
    },
  );

  // ── conflict resolution guide ────────────────────────────────────

  server.prompt(
    "conflict_resolution_guide",
    "Provide a structured guide for resolving a specific conflict, including context, pending work at risk, and historical precedents.",
    {
      pod_id: z.string().describe("Pod ID"),
      conflict_id: z.string().describe("Conflict ID"),
    },
    async ({ pod_id, conflict_id }) => {
      const [conflict, pendingWork, precedents] = await Promise.all([
        apiFetch<Conflict>(`/api/pods/${pod_id}/conflicts/${conflict_id}`),
        apiFetch<PendingWork[]>(`/api/conflicts/${conflict_id}/pending-work`),
        apiFetch<KnowledgeQueryResult>(
          `/api/knowledge/precedents?conflict=${encodeURIComponent(conflict_id)}&maxTokens=1500`,
        ),
      ]);

      return userMsg(`Help resolve this conflict. Provide a structured recommendation.

## Conflict
- **Summary:** ${conflict.summary}
- **Severity:** ${conflict.severity}
- **Status:** ${conflict.status}
- **Analysis:** ${conflict.master_analysis}
- **Impact:** ${conflict.impact.join("; ")}

## Opposing Sides
${conflict.sides.map((s) => `- **${s.contributor}:** ${s.position}`).join("\n")}

## Pending Work at Risk (${pendingWork.length} items)
${pendingWork.length === 0 ? "None" : pendingWork.map((w) => `- ${w.summary} (by ${w.agent_id}) — presumes: ${w.presumes} — rework cost: ${w.rework_cost}`).join("\n")}

## Historical Precedents (${precedents.total_matching} found)
${precedents.nodes.length === 0 ? "No relevant precedents in org knowledge." : precedents.nodes.map((n) => `- [${n.type}] ${n.summary}`).join("\n")}

Provide:
1. A recommended resolution with rationale
2. Which side's approach better serves the pod goals
3. How to minimize rework for pending items
4. Whether this sets a precedent worth capturing in org knowledge`);
    },
  );

  // ── pod health check ─────────────────────────────────────────────

  server.prompt(
    "pod_health_check",
    "Comprehensive health assessment of a pod: pressure trends, blocked areas, conflict load, lint issues, and recommendations.",
    { pod_id: z.string().describe("Pod ID") },
    async ({ pod_id }) => {
      const [pod, conflicts, updates, lintFindings] = await Promise.all([
        apiFetch<Pod>(`/api/pods/${pod_id}`),
        apiFetch<Conflict[]>(`/api/pods/${pod_id}/conflicts`),
        apiFetch<ContextUpdate[]>(`/api/pods/${pod_id}/context-updates`),
        apiFetch<Array<{ severity: string; message: string }>>(`/api/pods/${pod_id}/lint-findings`),
      ]);

      const openConflicts = conflicts.filter((c) => c.status !== "resolved");
      const blockedAreas = pod.areas.filter((a) => a.status === "blocked");
      const blockedUpdates = updates.filter((u) => u.status === "blocked");

      return userMsg(`Perform a health check for pod "${pod.name}" and provide actionable recommendations.

## Overview
- Day ${pod.day_number} of ${pod.total_days} (${Math.round((pod.day_number / pod.total_days) * 100)}% through sprint)
- Conflict pressure: ${pod.conflict_pressure} ${pod.conflict_pressure >= 0.8 ? "** CRITICAL — ingestion halted **" : pod.conflict_pressure >= 0.6 ? "** HIGH — contested areas held **" : ""}
- Milestone: ${pod.milestone.name} at ${pod.milestone.percent_complete}%

## Areas
${pod.areas.map((a) => `- ${a.scope}: ${a.status} (${a.owner})`).join("\n")}

## Blocked Areas: ${blockedAreas.length}
${blockedAreas.map((a) => `- ${a.scope} (${a.owner})`).join("\n") || "None"}

## Blocked Updates: ${blockedUpdates.length}
${blockedUpdates.slice(0, 5).map((u) => `- ${u.summary} (${u.agent_id})`).join("\n") || "None"}

## Open Conflicts: ${openConflicts.length}
${openConflicts.map((c) => `- [${c.severity}] ${c.summary}`).join("\n") || "None"}

## Lint Findings: ${lintFindings.length}
${lintFindings.slice(0, 10).map((f) => `- [${f.severity}] ${f.message}`).join("\n") || "None"}

Assess:
1. Overall pod health (green/yellow/red) with justification
2. Top risks to sprint completion
3. Specific actions to reduce pressure or unblock work
4. Whether the milestone target is realistic given current state`);
    },
  );

  // ── knowledge search ─────────────────────────────────────────────

  server.prompt(
    "knowledge_search",
    "Search org knowledge graph for relevant learnings, patterns, and historical decisions.",
    {
      query: z.string().describe("Search query describing what you're looking for"),
      domains: z.string().optional().describe("Comma-separated domain tags to filter by"),
    },
    async ({ query, domains }) => {
      const filters: Record<string, unknown> = {};
      if (domains) filters.domains = domains.split(",").map((d) => d.trim());

      const result = await apiPost<KnowledgeQueryResult>("/api/knowledge/query", {
        filters,
        query_text: query,
        max_tokens: 3000,
        include_details: true,
      });

      return userMsg(`Search the org knowledge base and summarize findings relevant to: "${query}"

## Results (${result.total_matching} matching, ${result.nodes.length} returned${result.truncated ? ", truncated to token budget" : ""})

${result.nodes.length === 0 ? "No matching knowledge found." : result.nodes.map((n) => `### [${n.type}] ${n.summary}
${n.details}
*Domains: ${n.domains.join(", ")}*
`).join("\n")}

Synthesize these learnings into actionable guidance. Highlight:
1. Relevant patterns or anti-patterns
2. Past decisions that apply to the current context
3. Anything surprising or counter-intuitive
4. Gaps where the org has no prior knowledge`);
    },
  );

  // ── session context (bidirectional pull) ──────────────────────────

  server.prompt(
    "session_context",
    "Pull bundled session context for an agent starting work. Returns living doc, pod state, open conflicts, recent activity, and relevant org learnings. Use this at the start of every work session.",
    {
      pod_id: z.string().describe("Pod ID"),
      scope: z.string().optional().describe("Agent scope: org-defined scope id (see GET /api/org/config) for filtered learnings"),
    },
    async ({ pod_id, scope }) => {
      // Fetch pod first so learnings can be scoped by its project_id (no cross-project knowledge bleed).
      const pod = await apiFetch<Pod & { project_id?: string | null }>(`/api/pods/${pod_id}`);
      const scopeParam = scope ? `&scopes=${encodeURIComponent(scope)}` : "";
      const projectParam = pod.project_id ? `&projectId=${encodeURIComponent(pod.project_id)}` : "";

      const [livingDoc, conflicts, updates, learnings] = await Promise.all([
        apiFetchText(`/api/pods/${pod_id}/living-doc`),
        apiFetch<Conflict[]>(`/api/pods/${pod_id}/conflicts`),
        apiFetch<ContextUpdate[]>(`/api/pods/${pod_id}/context-updates`),
        apiFetch<KnowledgeQueryResult>(
          `/api/knowledge/relevant?maxTokens=2000${scopeParam}${projectParam}`,
        ),
      ]);

      const openConflicts = conflicts.filter((c) => c.status !== "resolved");
      const recent = updates.slice(0, 20);

      const pressureWarning =
        pod.conflict_pressure >= 0.8
          ? "\n\n**CRITICAL: Conflict pressure >= 0.8 — ingestion is HALTED. Resolve conflicts before submitting updates.**"
          : pod.conflict_pressure >= 0.6
            ? "\n\n**WARNING: Conflict pressure >= 0.6 — contested areas are held. Review open conflicts before proceeding.**"
            : "";

      return userMsg(`You are starting a work session on pod "${pod.name}". Review this context before doing any work.

## Pod State
- Day ${pod.day_number} of ${pod.total_days}
- Conflict pressure: ${pod.conflict_pressure}${pressureWarning}
- Milestone: ${pod.milestone.name} (${pod.milestone.percent_complete}% complete, target ${pod.milestone.target_date})

## Areas
${pod.areas.map((a) => `- **${a.scope}** (${a.owner}): ${a.status}${a.last_activity ? ` — last active ${a.last_activity}` : ""}`).join("\n")}

## Living Document
${livingDoc.slice(0, 3000)}${livingDoc.length > 3000 ? "\n\n... (truncated — use get_context for full doc)" : ""}

## Open Conflicts (${openConflicts.length})
${openConflicts.length === 0 ? "None — clear to proceed." : openConflicts.map((c) => `- [${c.severity}] **${c.id}**: ${c.summary}\n  Analysis: ${c.master_analysis}`).join("\n")}

## Recent Activity (last ${recent.length} updates)
${recent.map((u) => `- [${u.type}/${u.scope}] ${u.summary} (${u.agent_id}, ${u.status})`).join("\n")}

## Relevant Org Knowledge (${learnings.total_matching} items${learnings.truncated ? ", truncated" : ""})
${learnings.nodes.length === 0 ? "No relevant learnings found." : learnings.nodes.map((n) => `- [${n.type}] ${n.summary}`).join("\n")}

## Your Responsibilities
${scope ? `Your scope is **${scope}**. Focus on updates and conflicts relevant to this area.` : "Scope not specified — review all areas."}

Based on this context:
1. Identify any open conflicts or blockers that affect your work
2. Note recent updates from other agents that you should be aware of
3. Check if any org learnings are relevant to your planned work
4. Proceed with your task, knowing that commits will auto-report to PIM`);
    },
  );

  // ── sprint kickoff ───────────────────────────────────────────────

  server.prompt(
    "sprint_kickoff",
    "Plan a sprint kickoff: review relevant org knowledge, suggest focus areas, and flag potential risks based on past pods.",
    {
      name: z.string().describe("Name for the new pod/sprint"),
      sprint_days: z.string().optional().describe("Sprint length in days (default 5)"),
      focus_areas: z.string().optional().describe("Comma-separated focus areas (e.g. 'auth,payments')"),
    },
    async ({ name, sprint_days, focus_areas }) => {
      const domains = focus_areas ? focus_areas.split(",").map((d) => d.trim()) : [];

      const [knowledge, archived] = await Promise.all([
        domains.length > 0
          ? apiPost<KnowledgeQueryResult>("/api/knowledge/query", {
              filters: { domains },
              max_tokens: 2000,
              include_details: true,
            })
          : Promise.resolve({ nodes: [], total_matching: 0, truncated: false } as KnowledgeQueryResult),
        apiFetch<Array<{ pod_id: string; name: string; duration_days: number; final_pressure: number }>>(
          "/api/org/archived",
        ),
      ]);

      return userMsg(`Help plan a sprint kickoff for "${name}" (${sprint_days ?? "5"} days).

## Relevant Org Knowledge (${knowledge.total_matching} items)
${knowledge.nodes.length === 0
  ? "No prior knowledge found for these domains."
  : knowledge.nodes.map((n) => `- [${n.type}] ${n.summary}`).join("\n")}

## Past Pods (${archived.length} archived)
${archived.slice(-5).map((p) => `- ${p.name}: ${p.duration_days} days, final pressure ${p.final_pressure}`).join("\n") || "No archived pods yet."}

${focus_areas ? `## Focus Areas\n${domains.map((d) => `- ${d}`).join("\n")}` : ""}

Provide a kickoff briefing:
1. Key learnings from past pods that apply here
2. Anti-patterns to avoid based on org history
3. Suggested area assignments and priorities
4. Potential risks and how to mitigate early
5. Recommended milestone structure for a ${sprint_days ?? "5"}-day sprint

After the briefing, the user can create the pod with the create_pod tool.`);
    },
  );

  // ── pod retrospective ────────────────────────────────────────────

  server.prompt(
    "pod_retrospective",
    "Generate a sprint retrospective for a pod before archival: what went well, what didn't, learnings to extract.",
    { pod_id: z.string().describe("Pod ID") },
    async ({ pod_id }) => {
      const [pod, conflicts, updates, livingDoc] = await Promise.all([
        apiFetch<Pod>(`/api/pods/${pod_id}`),
        apiFetch<Conflict[]>(`/api/pods/${pod_id}/conflicts`),
        apiFetch<ContextUpdate[]>(`/api/pods/${pod_id}/context-updates`),
        apiFetchText(`/api/pods/${pod_id}/living-doc`),
      ]);

      const resolved = conflicts.filter((c) => c.status === "resolved");
      const unresolved = conflicts.filter((c) => c.status !== "resolved");
      const decisions = updates.filter((u) => u.type === "decision");
      const blockers = updates.filter((u) => u.type === "blocker");

      return userMsg(`Generate a retrospective for pod "${pod.name}" before archival.

## Sprint Summary
- Duration: Day ${pod.day_number} of ${pod.total_days}
- Final pressure: ${pod.conflict_pressure}
- Milestone: ${pod.milestone.name} at ${pod.milestone.percent_complete}%

## Final Area Status
${pod.areas.map((a) => `- ${a.scope}: ${a.status} (${a.owner})`).join("\n")}

## Conflicts
- Resolved: ${resolved.length}
${resolved.map((c) => `  - ${c.summary} → ${c.resolution}`).join("\n")}
- Unresolved: ${unresolved.length}
${unresolved.map((c) => `  - [${c.severity}] ${c.summary}`).join("\n")}

## Key Decisions (${decisions.length})
${decisions.map((d) => `- ${d.summary} (${d.agent_id})`).join("\n") || "None recorded"}

## Blockers Encountered (${blockers.length})
${blockers.map((b) => `- ${b.summary} (${b.agent_id})`).join("\n") || "None recorded"}

## Total Updates: ${updates.length}

## Living Doc (final state)
${livingDoc.slice(0, 2000)}${livingDoc.length > 2000 ? "\n\n... (truncated)" : ""}

Generate a retrospective:
1. **What went well** — areas that shipped smoothly, conflicts resolved quickly
2. **What didn't go well** — persistent blockers, unresolved conflicts, pressure spikes
3. **Key learnings** — patterns worth capturing in org knowledge
4. **Process improvements** — what the team should do differently next sprint

After the retrospective, the user can archive the pod with the archive_pod tool to extract learnings into the knowledge graph.`);
    },
  );
}
