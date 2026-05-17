import "../src/load-env.js";
import { loadCredentials, ensureFreshToken } from "@pim/shared/auth";

const API_BASE = "https://d1ygncl0yqo6sv.cloudfront.net";
const creds = await ensureFreshToken(loadCredentials()!);
const headers = {
  Authorization: `Bearer ${creds.access_token}`,
  "X-Pim-Org": "emc-sandbox",
  "Content-Type": "application/json",
};

// Try with include_superseded=true to see if it was superseded
const res = await fetch(`${API_BASE}/api/knowledge/query`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    filters: { include_superseded: true },
    max_tokens: 20000,
    include_details: true,
    limit: 100,
  }),
});
const body = await res.json() as { nodes: Array<{ id: string; summary: string; superseded_by?: string; source_pod_name?: string }> };
console.log(`Total nodes (incl. superseded): ${body.nodes.length}`);
for (const n of body.nodes) {
  const sup = n.superseded_by ? ` SUPERSEDED_BY ${n.superseded_by}` : "";
  console.log(`  ${n.id} — src=${n.source_pod_name ?? "?"}${sup}\n    ${n.summary.slice(0, 100)}`);
}

// Also fetch the full graph for edges
const graphRes = await fetch(`${API_BASE}/api/knowledge/graph`, { headers });
const graph = await graphRes.json() as { nodes: Array<{ id: string; summary: string; superseded_by?: string }>; edges: Array<{ source: string; target: string; type: string }> };
console.log(`\nGraph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
for (const e of graph.edges) {
  console.log(`  edge ${e.type}: ${e.source} -> ${e.target}`);
}
