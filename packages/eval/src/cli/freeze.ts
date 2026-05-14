import "../load-env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pods as demoPods,
  conflicts as demoConflicts,
  contextUpdates as demoUpdates,
  livingDocs as demoLivingDocs,
} from "@pim/shared";
import type { SessionContextFixture } from "../arms/types.js";
import { getCuratedLearnings } from "./curated-learnings.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = join(dirname(__filename), "..", "..", "fixtures", "session-contexts");

const POD_IDS = ["pod-emc-rbac", "pod-emc-sessions", "pod-emc-configs"];

async function main(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const podsToFreeze = process.argv.slice(2).length > 0 ? process.argv.slice(2) : POD_IDS;

  for (const podId of podsToFreeze) {
    const pod = demoPods[podId];
    if (!pod) {
      console.warn(`[freeze] pod ${podId} not found in demo seed — skipping`);
      continue;
    }

    const fixture: SessionContextFixture = {
      podId,
      pulledAt: new Date().toISOString(),
      payload: {
        pod: {
          pod_id: pod.pod_id,
          name: pod.name,
          milestone: pod.milestone ? { name: pod.milestone.name } : undefined,
          conflict_pressure: pod.conflict_pressure,
          areas: pod.areas,
        },
        livingDocMarkdown: demoLivingDocs[podId] ?? "(no living doc)",
        conflicts: (demoConflicts[podId] ?? []).map((c) => ({
          id: c.id,
          summary: c.summary,
          severity: c.severity,
          status: c.status,
          sides: c.sides.map((s) => ({ contributor: s.contributor, position: s.position })),
          master_analysis: c.master_analysis,
          impact: c.impact,
        })),
        relevantLearnings: getCuratedLearnings(podId),
        recentUpdates: (demoUpdates[podId] ?? []).slice(0, 12).map((u) => ({
          agent_id: u.agent_id,
          timestamp: u.timestamp,
          type: u.type,
          summary: u.summary,
          details: u.details,
          status: u.status,
        })),
      },
    };

    const path = join(FIXTURES_DIR, `${podId}.json`);
    await writeFile(path, JSON.stringify(fixture, null, 2));
    console.log(`[freeze] wrote ${path} (${fixture.payload.conflicts.length} conflicts, ${fixture.payload.relevantLearnings.nodes.length} learnings, ${fixture.payload.recentUpdates.length} updates)`);
  }
}

main().catch((err) => {
  console.error("[freeze] failed:", err);
  process.exit(1);
});
