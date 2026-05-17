/**
 * Read-only diagnostic: dumps every node currently in the emc-sandbox graph
 * and shows what /api/knowledge/relevant returns for several scope/query combos.
 *
 * Use this when freeze.ts is producing surprisingly few learnings — it helps
 * tell apart "the node isn't there" from "the node is there but not being
 * ranked into the result set."
 */

import "../src/load-env.js";
import {
  loadCredentials,
  ensureFreshToken,
  assertSecurePermissions,
} from "@pim/shared/auth";

const API_BASE =
  process.env.PIM_API_URL?.replace(/\/+$/, "") ??
  "https://d1ygncl0yqo6sv.cloudfront.net";
const SANDBOX_SLUG = "emc-sandbox";

async function main(): Promise<void> {
  assertSecurePermissions();
  const creds = loadCredentials();
  if (!creds) throw new Error("No credentials");
  const fresh = await ensureFreshToken(creds);
  const headers = {
    Authorization: `Bearer ${fresh.access_token}`,
    "X-Pim-Org": SANDBOX_SLUG,
    "Content-Type": "application/json",
  };

  // Dump everything in the org's graph
  const queryRes = await fetch(`${API_BASE}/api/knowledge/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      filters: {},
      max_tokens: 20000,
      include_details: false,
      limit: 100,
    }),
  });
  const queryBody = (await queryRes.json()) as { nodes: Array<{ id: string; domains: string[]; type: string; summary: string }> };
  console.log(`[inspect] /api/knowledge/query (no filters): ${queryBody.nodes.length} nodes`);
  for (const n of queryBody.nodes) {
    console.log(`  - ${n.id} [${n.type}] domains=${JSON.stringify(n.domains)} — ${n.summary.slice(0, 70)}`);
  }

  // Reproduce the verify call exactly
  const scopes = encodeURIComponent("frontend,backend");
  const query = encodeURIComponent("ESP PUT contract speakers session-time optimistic concurrency");
  const relRes = await fetch(
    `${API_BASE}/api/knowledge/relevant?scopes=${scopes}&maxTokens=4000&query=${query}`,
    { headers },
  );
  const relBody = (await relRes.json()) as { nodes: Array<{ id: string; summary: string }>; total_matching?: number; truncated?: boolean };
  console.log(`\n[inspect] /api/knowledge/relevant?scopes=frontend,backend&query=...: ${relBody.nodes.length} nodes (total_matching=${relBody.total_matching}, truncated=${relBody.truncated})`);
  for (const n of relBody.nodes) {
    console.log(`  - ${n.id} — ${n.summary.slice(0, 70)}`);
  }

  // Same call with frontend-only
  const scopesFE = encodeURIComponent("frontend");
  const relFE = await fetch(
    `${API_BASE}/api/knowledge/relevant?scopes=${scopesFE}&maxTokens=4000&query=${query}`,
    { headers },
  );
  const relFEBody = (await relFE.json()) as { nodes: Array<{ id: string; summary: string }>; total_matching?: number };
  console.log(`\n[inspect] /api/knowledge/relevant?scopes=frontend&query=...: ${relFEBody.nodes.length} nodes (total_matching=${relFEBody.total_matching})`);
  for (const n of relFEBody.nodes) {
    console.log(`  - ${n.id} — ${n.summary.slice(0, 70)}`);
  }
}

main().catch((err) => {
  console.error("[inspect] error:", err);
  process.exit(1);
});
