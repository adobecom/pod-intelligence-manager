/**
 * Single-node partitioning probe.
 *
 * Writes ONE clearly-marked test node to emc-sandbox via HTTP and prints
 * its node_id. Operator then verifies via MCP query (which hits the user's
 * first org = T3 Events) that the node is NOT visible there. If the probe
 * is invisible from production, KG partitioning is live and we can safely
 * proceed with the full re-seed.
 *
 * Usage:
 *   cd packages/eval && pnpm exec tsx scripts/probe-partition.ts
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

const PROBE_NODE = {
  type: "pattern" as const,
  summary:
    "PARTITION-PROBE-2026-05-12 — sandbox isolation test (delete me if it shows up in production)",
  details:
    "This node was written to the emc-sandbox org by packages/eval/scripts/probe-partition.ts to verify that the knowledge graph is now partitioned by org_id. If you see this node when querying outside the emc-sandbox org, partitioning is broken; otherwise it is working as intended and can be deleted at any time.",
  domains: ["test"],
  confidence_score: 0.1,
  source_label: "partition-probe",
};

async function main(): Promise<void> {
  assertSecurePermissions();
  const creds = loadCredentials();
  if (!creds) throw new Error("No credentials at ~/.pim/credentials.json");
  const fresh = await ensureFreshToken(creds);

  console.log(`[probe] writing test node to ${API_BASE} with X-Pim-Org=${SANDBOX_SLUG}`);
  const res = await fetch(`${API_BASE}/api/knowledge/nodes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${fresh.access_token}`,
      "X-Pim-Org": SANDBOX_SLUG,
    },
    body: JSON.stringify(PROBE_NODE),
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }

  if (res.status !== 200 && res.status !== 201) {
    console.error(`[probe] failed: ${res.status} — ${typeof body === "string" ? body : JSON.stringify(body)}`);
    process.exit(1);
  }

  const nodeId = (body as { nodeId?: string }).nodeId;
  console.log(`[probe] wrote node ${nodeId} into emc-sandbox.`);
  console.log(`[probe] now query via MCP (which hits T3 Events): the probe should NOT appear.`);
  console.log(`[probe] node_id=${nodeId}`);
}

main().catch((err) => {
  console.error("[probe] error:", err);
  process.exit(1);
});
