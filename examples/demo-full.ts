/**
 * AI Council — Full Lifecycle Demo
 *
 * Walks through the complete Council pipeline:
 *   Part A: Creates a fresh pod, submits updates, shows the pipeline
 *   Part B: Uses the seeded "Checkout Redesign" pod to demo conflicts & resolution
 *
 * Usage:
 *   1. Start the server: pnpm --filter @council/server dev
 *   2. Optionally start the UI: pnpm --filter @council/ui dev
 *   3. Run this script: npx tsx examples/demo-full.ts
 *
 * Note: Without AWS_BEARER_TOKEN_BEDROCK, updates are merged deterministically (no LLM).
 * The seeded pods have pre-existing conflicts to demonstrate the full conflict flow.
 */

import { CouncilClient } from "../packages/sdk/src/client.js";

const BASE = "http://localhost:4000";
const DIVIDER = "═".repeat(64);
const STEP_PAUSE = 1200;

function step(n: number, title: string) {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  Step ${n}: ${title}`);
  console.log("─".repeat(64));
}

function hint(msg: string) {
  console.log(`\n  --> ${msg}`);
}

async function pause() {
  await new Promise((r) => setTimeout(r, STEP_PAUSE));
}

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function main() {
  console.log(`\n${DIVIDER}`);
  console.log("  AI Council — Full Lifecycle Demo");
  console.log(DIVIDER);

  // ═══════════════════════════════════════════════════════════
  // Part A: Fresh Pod — Context Update Pipeline
  // ═══════════════════════════════════════════════════════════

  // ── Step 1: Create a fresh pod ──
  step(1, "Create a fresh pod");
  const suffix = Date.now().toString(36).slice(-4);
  const podName = `Demo Sprint ${suffix}`;
  const pod = await fetchJSON<any>(`${BASE}/api/pods`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: podName, sprint_days: 5 }),
  });
  console.log(`  Created: ${pod.pod_id}`);
  console.log(`  Sprint: Day ${pod.day_number} of ${pod.total_days}`);
  console.log(`  Pressure: ${pod.conflict_pressure}`);
  hint("Open http://localhost:5173 — 'Demo Sprint' appears in the Org Dashboard.");
  await pause();

  // ── Step 2: Submit a progress update (auto-merge) ──
  step(2, "Submit a progress update (auto-merge)");
  const feAgent = new CouncilClient({
    baseUrl: BASE,
    podId: pod.pod_id,
    agentId: "fe-agent",
    scope: "frontend",
  });
  const r1 = await feAgent.report({
    type: "progress",
    summary: "Implemented the product listing page with search and filters",
    details: "ProductList component renders items from API. Filter panel supports price range, category, and rating. Responsive grid layout with Spectrum 2 cards.",
    artifacts: [{ type: "component", path: "src/components/ProductList.tsx" }],
    status: "completed",
  });
  console.log(`  Classification: ${r1.council.classification}`);
  console.log(`  Merged: ${r1.council.merged}`);
  await pause();

  // ── Step 3: Submit a backend update ──
  step(3, "Submit a backend progress update");
  const beAgent = new CouncilClient({
    baseUrl: BASE,
    podId: pod.pod_id,
    agentId: "be-agent",
    scope: "backend",
  });
  const r2 = await beAgent.report({
    type: "progress",
    summary: "Built the product API with pagination and filtering",
    details: "GET /api/products supports page, limit, category, price_min, price_max, sort_by params. Returns paginated results with total count. 50ms p99 latency.",
    artifacts: [{ type: "api", path: "src/routes/products.ts" }],
    status: "completed",
  });
  console.log(`  Classification: ${r2.council.classification}`);
  console.log(`  Merged: ${r2.council.merged}`);
  await pause();

  // ── Step 4: Record a decision ──
  step(4, "Record a technical decision");
  const r3 = await feAgent.report({
    type: "decision",
    summary: "Use TanStack Query for API data fetching and caching",
    details: "TanStack Query handles caching, deduplication, and background refetching. Preferred over manual fetch + useState for the product listing and cart pages.",
    status: "completed",
  });
  console.log(`  Classification: ${r3.council.classification}`);
  hint("Check the Living Doc — decisions appear in the 'Recent Decisions' section.");
  await pause();

  // ── Step 5: Submit a blocker ──
  step(5, "Report a blocker");
  const r4 = await beAgent.report({
    type: "blocker",
    summary: "Cannot deploy API — staging environment DNS is misconfigured",
    details: "Route 53 A record for api-staging.example.com points to the old load balancer. Infra team ticket filed (INFRA-412).",
    status: "blocked",
    blocked_by: ["INFRA-412"],
    needs_input_from: [{ role: "infra", question: "ETA for DNS fix?" }],
  });
  console.log(`  Classification: ${r4.council.classification}`);
  console.log(`  This update will appear in the Context Feed as a blocker.`);
  await pause();

  // ── Step 6: View the living doc ──
  step(6, "View the living doc for our new pod");
  const docRes1 = await fetch(`${BASE}/api/pods/${pod.pod_id}/living-doc`);
  const markdown1 = await docRes1.text();
  const lines1 = markdown1.split("\n");
  console.log();
  for (const line of lines1.slice(0, 25)) {
    console.log(`  ${line}`);
  }
  if (lines1.length > 25) console.log(`  ... (${lines1.length} total lines)`);
  hint(`Full doc: http://localhost:5173/pod/${pod.pod_id}/doc`);
  await pause();

  // ═══════════════════════════════════════════════════════════
  // Part B: Seeded Pod — Conflict Resolution Flow
  // ═══════════════════════════════════════════════════════════

  console.log(`\n${"═".repeat(64)}`);
  console.log("  Part B: Conflict Resolution (seeded Checkout Redesign pod)");
  console.log("═".repeat(64));

  // ── Step 7: Examine the Checkout Redesign pod (has seeded conflicts) ──
  step(7, "Examine seeded conflicts in Checkout Redesign");
  const checkoutPod = await fetchJSON<any>(`${BASE}/api/pods/pod-checkout-redesign`);
  console.log(`  Pod: ${checkoutPod.name}`);
  console.log(`  Pressure: ${checkoutPod.conflict_pressure.toFixed(2)}`);

  const conflicts = await fetchJSON<any[]>(`${BASE}/api/pods/pod-checkout-redesign/conflicts`);
  const openConflicts = conflicts.filter((c: any) => c.status !== "resolved");
  console.log(`  Open conflicts: ${openConflicts.length}`);
  for (const c of openConflicts) {
    console.log(`\n  ${c.id}: ${c.summary}`);
    console.log(`    Severity: ${c.severity} | Status: ${c.status}`);
    if (c.master_analysis) {
      const analysis = c.master_analysis.length > 150
        ? c.master_analysis.slice(0, 150) + "..."
        : c.master_analysis;
      console.log(`    Analysis: ${analysis}`);
    }
  }
  hint("Open the Conflict Center: http://localhost:5173/pod/pod-checkout-redesign/conflicts");
  await pause();

  // ── Step 8: Resolve a conflict ──
  step(8, "Resolve a conflict and watch pressure drop");
  const conflictToResolve = openConflicts[0];
  if (conflictToResolve) {
    console.log(`  Resolving: ${conflictToResolve.id}`);
    console.log(`  Before — Pressure: ${checkoutPod.conflict_pressure.toFixed(2)}`);

    const resolved = await fetchJSON<any>(
      `${BASE}/api/pods/pod-checkout-redesign/conflicts/${conflictToResolve.id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolution: "Adopt strikethrough display for discounts. Design team will update mockup v4 to match the implemented approach. Three downstream updates already assume this pattern.",
          resolved_by: "pod-lead",
        }),
      },
    );
    console.log(`  Status: ${resolved.status}`);
    console.log(`  Resolution: ${resolved.resolution}`);

    const podAfter = await fetchJSON<any>(`${BASE}/api/pods/pod-checkout-redesign`);
    console.log(`\n  After — Pressure: ${podAfter.conflict_pressure.toFixed(2)}`);
    hint("Watch the pressure gauge drop in the Pod Dashboard!");
  } else {
    console.log("  No open conflicts to resolve (all already resolved).");
  }
  await pause();

  // ── Step 9: Run a lint pass ──
  step(9, "Run a lint pass on Checkout Redesign");
  const lintResult = await fetchJSON<any>(`${BASE}/api/pods/pod-checkout-redesign/lint`, {
    method: "POST",
  });
  console.log(`  Findings: ${lintResult.findings.length}`);
  for (const f of lintResult.findings.slice(0, 5)) {
    console.log(`    [${f.severity}] ${f.type}: ${f.summary}`);
  }
  if (lintResult.findings.length === 0) {
    console.log("  No issues found.");
  }
  await pause();

  // ── Step 10: Show the Checkout Redesign living doc ──
  step(10, "Checkout Redesign Living Doc");
  const docRes2 = await fetch(`${BASE}/api/pods/pod-checkout-redesign/living-doc`);
  const markdown2 = await docRes2.text();
  const lines2 = markdown2.split("\n");
  console.log();
  for (const line of lines2.slice(0, 30)) {
    console.log(`  ${line}`);
  }
  if (lines2.length > 30) console.log(`  ... (${lines2.length} total lines)`);

  // ── Done ──
  console.log(`\n${DIVIDER}`);
  console.log("  Demo complete!");
  console.log();
  console.log("  The UI at http://localhost:5173 shows everything in real time:");
  console.log("    - Org Dashboard: all pods with health at a glance");
  console.log(`    - New pod: http://localhost:5173/pod/${pod.pod_id}`);
  console.log("    - Checkout pod: http://localhost:5173/pod/pod-checkout-redesign");
  console.log("    - Conflicts: http://localhost:5173/pod/pod-checkout-redesign/conflicts");
  console.log();
  console.log("  Try the CLI next:");
  console.log("    npx tsx packages/cli/src/index.ts pod list");
  console.log("    npx tsx packages/cli/src/index.ts doc pod-checkout-redesign");
  console.log(DIVIDER);
  console.log();
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
