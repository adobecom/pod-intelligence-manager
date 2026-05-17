/**
 * One-shot cleanup: rejects the dataFilter-naming node that was originally
 * seeded with type=decision and triggered an auto-supersedes edge against
 * the event-speaker contract. After rejection, the supersedes pointer on
 * the speaker-contract node clears (knowledge-graph.ts:466-470), making it
 * visible again, and seed-sandbox.ts will resubmit the dataFilter-naming
 * entry as type=pattern on the next run.
 */

import "../src/load-env.js";
import { loadCredentials, ensureFreshToken } from "@pim/shared/auth";

const API_BASE =
  process.env.PIM_API_URL?.replace(/\/+$/, "") ??
  "https://d1ygncl0yqo6sv.cloudfront.net";
const SANDBOX_SLUG = "emc-sandbox";

const TARGET_SUMMARY_PREFIX = "Per-resource PUT payload sanitizers live in utils/dataFilters.ts";

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error("No credentials");
  const fresh = await ensureFreshToken(creds);
  const headers = {
    Authorization: `Bearer ${fresh.access_token}`,
    "X-Pim-Org": SANDBOX_SLUG,
    "Content-Type": "application/json",
  };

  // Find the decision-typed dataFilter node
  const listRes = await fetch(`${API_BASE}/api/knowledge/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      filters: { include_superseded: true, types: ["decision"] },
      max_tokens: 20000,
      include_details: false,
      limit: 50,
    }),
  });
  const list = (await listRes.json()) as { nodes: Array<{ id: string; type: string; summary: string }> };
  const target = list.nodes.find((n) => n.summary.startsWith(TARGET_SUMMARY_PREFIX));
  if (!target) {
    console.log("[fix] no decision-typed dataFilter node to clean up — nothing to do");
    return;
  }
  console.log(`[fix] rejecting ${target.id} — ${target.summary.slice(0, 80)}`);
  const curRes = await fetch(`${API_BASE}/api/knowledge/nodes/${target.id}/curate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "reject" }),
  });
  if (!curRes.ok) {
    console.error(`[fix] reject failed: ${curRes.status} ${await curRes.text()}`);
    process.exit(1);
  }
  console.log(`[fix] rejected. speaker-contract node should now be un-superseded.`);
}

main().catch((err) => {
  console.error("[fix] error:", err);
  process.exit(1);
});
