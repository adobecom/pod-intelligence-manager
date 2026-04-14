/**
 * Demo Agent — exercises the full Council pipeline via the SDK.
 *
 * Usage:
 *   1. Start the server: pnpm --filter @council/server dev
 *   2. Run this script:  npx tsx examples/demo-agent.ts
 */

import { CouncilClient } from "../packages/sdk/src/client.js";

const DIVIDER = "═".repeat(60);

async function main() {
  console.log(DIVIDER);
  console.log("  AI Council — Demo Agent");
  console.log(DIVIDER);
  console.log();

  // Create two agents in different scopes
  const feAgent = new CouncilClient({
    baseUrl: "http://localhost:4000",
    podId: "pod-checkout-redesign",
    agentId: "demo-fe-agent",
    scope: "frontend",
  });

  const beAgent = new CouncilClient({
    baseUrl: "http://localhost:4000",
    podId: "pod-checkout-redesign",
    agentId: "demo-be-agent",
    scope: "backend",
  });

  // 1. Check initial pod state
  console.log("1. Checking initial pod state...");
  const pod = await feAgent.getPod();
  console.log(`   Pod: ${pod.name}`);
  console.log(`   Day ${pod.day_number} of ${pod.total_days}`);
  console.log(`   Pressure: ${pod.conflict_pressure}`);
  console.log(`   Milestone: ${pod.milestone.name} (${pod.milestone.percent_complete}%)`);
  console.log();

  // 2. Submit an additive progress update (new scope area)
  console.log("2. Submitting additive progress update (backend)...");
  const r1 = await beAgent.report({
    type: "progress",
    summary: "Payment gateway integration complete",
    details: "Stripe webhook handler and payment intent creation working. Handles card, Apple Pay, Google Pay.",
    artifacts: [{ type: "api", path: "src/routes/payments.ts" }],
    status: "completed",
  });
  console.log(`   ID: ${r1.id}`);
  console.log(`   Classification: ${r1.council.classification}`);
  console.log(`   Merged: ${r1.council.merged}`);
  console.log();

  // 3. Submit a decision
  console.log("3. Submitting a decision...");
  const r2 = await feAgent.report({
    type: "decision",
    summary: "Use CSS Grid for checkout layout instead of Flexbox",
    details: "CSS Grid provides better alignment control for the two-column checkout layout (cart + summary). Works well with responsive breakpoints.",
    status: "completed",
  });
  console.log(`   ID: ${r2.id}`);
  console.log(`   Classification: ${r2.council.classification}`);
  console.log();

  // 4. Submit a blocker
  console.log("4. Submitting a blocker...");
  const r3 = await feAgent.report({
    type: "blocker",
    summary: "Cannot test payment flow without Stripe test keys",
    details: "The payment integration requires Stripe test API keys. Currently waiting on infra team to provision test environment credentials.",
    status: "blocked",
    blocked_by: ["stripe-test-keys"],
    needs_input_from: [{ role: "infra", question: "When will Stripe test keys be available?" }],
  });
  console.log(`   ID: ${r3.id}`);
  console.log(`   Classification: ${r3.council.classification}`);
  console.log();

  // 5. Check current conflicts
  console.log("5. Current conflicts...");
  const conflicts = await feAgent.getConflicts();
  for (const c of conflicts) {
    console.log(`   ${c.id}: ${c.summary} [${c.status}] (${c.severity})`);
  }
  console.log();

  // 6. Fetch the regenerated living doc
  console.log("6. Living doc (first 20 lines)...");
  const doc = await feAgent.getContext();
  const lines = doc.split("\n");
  for (const line of lines.slice(0, 20)) {
    console.log(`   ${line}`);
  }
  console.log(`   ... (${lines.length} total lines)`);
  console.log();

  // 7. Check updated pod state
  console.log("7. Updated pod state...");
  const updatedPod = await feAgent.getPod();
  console.log(`   Pressure: ${updatedPod.conflict_pressure}`);
  const updates = await feAgent.getUpdates();
  console.log(`   Total context updates: ${updates.length}`);
  console.log();

  console.log(DIVIDER);
  console.log("  Demo complete. The UI at localhost:5173 reflects all changes.");
  console.log(DIVIDER);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
