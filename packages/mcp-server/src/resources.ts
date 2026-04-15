import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiFetch, apiFetchText } from "./api.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

interface OrgPodSummary {
  pod_id: string;
  name: string;
}

function podResourceLister(pathSuffix: string, descriptionFn: (name: string) => string) {
  return async () => {
    try {
      const pods = await apiFetch<OrgPodSummary[]>("/api/org/pods");
      return {
        resources: pods.map((p) => ({
          uri: `council://pods/${p.pod_id}${pathSuffix}`,
          name: `${p.name}${pathSuffix}`,
          description: descriptionFn(p.name),
        })),
      };
    } catch {
      return { resources: [] };
    }
  };
}

function jsonContents(uri: URL, data: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function textContents(uri: URL, text: string, mimeType = "text/markdown") {
  return {
    contents: [{ uri: uri.href, mimeType, text }],
  };
}

/* ------------------------------------------------------------------ */
/*  Registration                                                      */
/* ------------------------------------------------------------------ */

export function registerResources(server: McpServer) {
  // ── static org-level resources ───────────────────────────────────

  server.resource(
    "org-pods",
    "council://org/pods",
    { description: "All active pod summaries (IDs, names, pressure, conflicts, agents)" },
    async (uri) => jsonContents(uri, await apiFetch("/api/org/pods")),
  );

  server.resource(
    "org-overlaps",
    "council://org/overlaps",
    { description: "Cross-pod overlap advisories" },
    async (uri) => jsonContents(uri, await apiFetch("/api/org/overlaps")),
  );

  server.resource(
    "org-archived",
    "council://org/archived",
    { description: "Archived pods with completion dates and final pressure" },
    async (uri) => jsonContents(uri, await apiFetch("/api/org/archived")),
  );

  server.resource(
    "knowledge-stats",
    "council://knowledge/stats",
    { description: "Knowledge graph statistics (node/edge counts, top domains)" },
    async (uri) => jsonContents(uri, await apiFetch("/api/knowledge/stats")),
  );

  // ── pod-scoped resource templates ────────────────────────────────

  server.resource(
    "pod",
    new ResourceTemplate("council://pods/{pod_id}", {
      list: podResourceLister("", (name) => `Pod metadata for ${name}`),
    }),
    { description: "Pod metadata, areas, milestone, and pressure" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}`)),
  );

  server.resource(
    "pod-living-doc",
    new ResourceTemplate("council://pods/{pod_id}/living-doc", {
      list: podResourceLister("/living-doc", (name) => `Living doc for ${name}`),
    }),
    { description: "Living document markdown for a pod" },
    async (uri, { pod_id }) =>
      textContents(uri, await apiFetchText(`/api/pods/${pod_id}/living-doc`)),
  );

  server.resource(
    "pod-conflicts",
    new ResourceTemplate("council://pods/{pod_id}/conflicts", {
      list: podResourceLister("/conflicts", (name) => `Conflicts for ${name}`),
    }),
    { description: "All conflicts for a pod (open, in discussion, resolved)" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}/conflicts`)),
  );

  server.resource(
    "pod-context-updates",
    new ResourceTemplate("council://pods/{pod_id}/context-updates", {
      list: podResourceLister("/context-updates", (name) => `Context updates for ${name}`),
    }),
    { description: "Context update feed for a pod (progress, blockers, decisions)" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}/context-updates`)),
  );

  server.resource(
    "pod-tunnels",
    new ResourceTemplate("council://pods/{pod_id}/tunnels", {
      list: podResourceLister("/tunnels", (name) => `Tunnels for ${name}`),
    }),
    { description: "Active dev tunnels for a pod" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}/tunnels`)),
  );

  server.resource(
    "pod-lint-findings",
    new ResourceTemplate("council://pods/{pod_id}/lint-findings", {
      list: podResourceLister("/lint-findings", (name) => `Lint findings for ${name}`),
    }),
    { description: "Lint findings for a pod (consistency issues, stale blockers)" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}/lint-findings`)),
  );

  // ── knowledge graph (full, for visualization clients) ────────────

  server.resource(
    "knowledge-graph",
    "council://knowledge/graph",
    { description: "Full knowledge graph (nodes, edges, communities) — may be large" },
    async (uri) => jsonContents(uri, await apiFetch("/api/knowledge/graph")),
  );
}
