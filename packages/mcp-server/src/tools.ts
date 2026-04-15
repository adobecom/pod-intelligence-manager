import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildArtifact } from "./artifact-template.js";

const API_BASE = process.env.COUNCIL_API_URL ?? "http://localhost:4000";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Council API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function apiFetchText(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`Council API ${res.status}: ${await res.text()}`);
  }
  return res.text();
}

export function registerTools(server: McpServer) {
  server.tool(
    "list_pods",
    "List all active pods in the organization. Returns pod IDs, names, day/total, pressure, open conflicts, and agent counts.",
    {},
    async () => {
      const pods = await apiFetch<unknown[]>("/api/org/pods");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(pods, null, 2) }],
      };
    },
  );

  server.tool(
    "render_pod_dashboard",
    "Fetch all data for a pod and return a complete React component. Render the returned code as a React artifact to show the user an interactive pod dashboard with tabs for Dashboard, Conflicts, Feed, and Live Doc.",
    { pod_id: z.string().describe("The pod ID (e.g. 'pod-checkout-redesign')") },
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

      const data = {
        pod,
        conflicts,
        contextUpdates,
        livingDoc,
        tunnels,
        lintFindings,
        generatedAt: new Date().toISOString(),
      };

      const artifact = buildArtifact(data);

      return {
        content: [{ type: "text" as const, text: artifact }],
      };
    },
  );
}
