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

interface ProjectSummary {
  project_id: string;
  name: string;
}

function podResourceLister(pathSuffix: string, descriptionFn: (name: string) => string) {
  return async () => {
    try {
      const pods = await apiFetch<OrgPodSummary[]>("/api/org/pods");
      return {
        resources: pods.map((p) => ({
          uri: `pim://pods/${p.pod_id}${pathSuffix}`,
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
    "pim://org/pods",
    { description: "All active pod summaries (IDs, names, pressure, conflicts, agents)" },
    async (uri) => jsonContents(uri, await apiFetch("/api/org/pods")),
  );

  server.resource(
    "org-overlaps",
    "pim://org/overlaps",
    { description: "Cross-pod overlap advisories" },
    async (uri) => jsonContents(uri, await apiFetch("/api/org/overlaps")),
  );

  server.resource(
    "org-archived",
    "pim://org/archived",
    { description: "Archived pods with completion dates and final pressure" },
    async (uri) => jsonContents(uri, await apiFetch("/api/org/archived")),
  );

  server.resource(
    "org-archived-projects",
    "council://org/archived-projects",
    { description: "Archived initiatives: id, name, description, anatomy snapshot, created_at, archived_date" },
    async (uri) => jsonContents(uri, await apiFetch("/api/org/archived-projects")),
  );

  server.resource(
    "org-config",
    "council://org/config",
    { description: "Org-wide scope definitions (ids + labels) for pods, context updates, and project anatomy" },
    async (uri) => jsonContents(uri, await apiFetch("/api/org/config")),
  );

  server.resource(
    "org-projects",
    "council://org/projects",
    { description: "All long-lived projects with anatomy and metadata" },
    async (uri) => jsonContents(uri, await apiFetch("/api/projects")),
  );

  server.resource(
    "knowledge-stats",
    "pim://knowledge/stats",
    { description: "Knowledge graph statistics (node/edge counts, top domains)" },
    async (uri) => jsonContents(uri, await apiFetch("/api/knowledge/stats")),
  );

  // ── pod-scoped resource templates ────────────────────────────────

  server.resource(
    "project",
    new ResourceTemplate("council://projects/{project_id}", {
      list: async () => {
        try {
          const projects = await apiFetch<ProjectSummary[]>("/api/projects");
          return {
            resources: projects.map((p) => ({
              uri: `council://projects/${p.project_id}`,
              name: p.name,
              description: `Project metadata and anatomy for ${p.name}`,
            })),
          };
        } catch {
          return { resources: [] };
        }
      },
    }),
    { description: "Project metadata, description, and anatomy (internal scopes + external teams)" },
    async (uri, { project_id }) => {
      const id = Array.isArray(project_id) ? project_id[0] : project_id;
      return jsonContents(uri, await apiFetch(`/api/projects/${encodeURIComponent(String(id))}`));
    },
  );

  server.resource(
    "pod",
    new ResourceTemplate("pim://pods/{pod_id}", {
      list: podResourceLister("", (name) => `Pod metadata for ${name}`),
    }),
    { description: "Pod metadata, areas, milestone, and pressure" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}`)),
  );

  server.resource(
    "pod-living-doc",
    new ResourceTemplate("pim://pods/{pod_id}/living-doc", {
      list: podResourceLister("/living-doc", (name) => `Living doc for ${name}`),
    }),
    { description: "Living document markdown for a pod" },
    async (uri, { pod_id }) =>
      textContents(uri, await apiFetchText(`/api/pods/${pod_id}/living-doc`)),
  );

  server.resource(
    "pod-conflicts",
    new ResourceTemplate("pim://pods/{pod_id}/conflicts", {
      list: podResourceLister("/conflicts", (name) => `Conflicts for ${name}`),
    }),
    { description: "All conflicts for a pod (open, in discussion, resolved)" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}/conflicts`)),
  );

  server.resource(
    "pod-context-updates",
    new ResourceTemplate("pim://pods/{pod_id}/context-updates", {
      list: podResourceLister("/context-updates", (name) => `Context updates for ${name}`),
    }),
    { description: "Context update feed for a pod (progress, blockers, decisions)" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}/context-updates`)),
  );

  server.resource(
    "pod-tunnels",
    new ResourceTemplate("pim://pods/{pod_id}/tunnels", {
      list: podResourceLister("/tunnels", (name) => `Tunnels for ${name}`),
    }),
    { description: "Active dev tunnels for a pod" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}/tunnels`)),
  );

  server.resource(
    "pod-lint-findings",
    new ResourceTemplate("pim://pods/{pod_id}/lint-findings", {
      list: podResourceLister("/lint-findings", (name) => `Lint findings for ${name}`),
    }),
    { description: "Lint findings for a pod (consistency issues, stale blockers)" },
    async (uri, { pod_id }) =>
      jsonContents(uri, await apiFetch(`/api/pods/${pod_id}/lint-findings`)),
  );

  // ── knowledge graph (full, for visualization clients) ────────────

  server.resource(
    "knowledge-graph",
    "pim://knowledge/graph",
    { description: "Full knowledge graph (nodes, edges, communities) — may be large" },
    async (uri) => jsonContents(uri, await apiFetch("/api/knowledge/graph")),
  );
}
