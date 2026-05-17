import "../src/load-env.js";
import { loadCredentials, ensureFreshToken } from "@pim/shared/auth";

const API_BASE = "https://d1ygncl0yqo6sv.cloudfront.net";
const creds = await ensureFreshToken(loadCredentials()!);
const headers = {
  Authorization: `Bearer ${creds.access_token}`,
  "X-Pim-Org": "emc-sandbox",
};

const cases = [
  { pod: "pod-emc-sessions", scopes: "frontend,backend", query: "v0.1 — Session CRUD + Timezone Handling" },
  { pod: "pod-emc-rbac",     scopes: "frontend,backend", query: "v0.1 — Permission Gating + Group Context" },
  { pod: "pod-emc-configs",  scopes: "frontend,backend", query: "v0.1 — Config CRUD + Inheritance Model" },
];
for (const c of cases) {
  const url = `${API_BASE}/api/knowledge/relevant?scopes=${encodeURIComponent(c.scopes)}&maxTokens=4000&query=${encodeURIComponent(c.query)}`;
  const res = await fetch(url, { headers });
  const body = await res.json() as { nodes: Array<{ id: string; summary: string }>; total_matching?: number };
  console.log(`\n[${c.pod}] query="${c.query}" → ${body.nodes.length} nodes (matching ${body.total_matching})`);
  for (const n of body.nodes) console.log(`  - ${n.id} — ${n.summary.slice(0, 90)}`);
}
