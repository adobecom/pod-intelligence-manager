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
import {
  loadCredentials,
  ensureFreshToken,
  assertSecurePermissions,
} from "@pim/shared/auth";
import type { FixtureLearnings, LivingDocSection, SessionContextFixture } from "../arms/types.js";
import type { Task } from "../tasks/types.js";
import { ALL_TASKS } from "../tasks/index.js";
import { applyAssignmentsToAll } from "../tasks/stratification.js";
import { getCuratedLearnings } from "./curated-learnings.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = join(dirname(__filename), "..", "..", "fixtures", "session-contexts");

const POD_IDS = ["pod-emc-rbac", "pod-emc-sessions", "pod-emc-configs"];

// Live KG retrieval for the PIM fixture. Set USE_OFFLINE_LEARNINGS=1 to skip
// the HTTP call and fall back to the hand-curated shim (useful when offline or
// when comparing the offline baseline against the live-retrieval result).
const EVAL_PIM_BASE_URL =
  process.env.EVAL_PIM_BASE_URL?.replace(/\/+$/, "") ??
  "https://d1ygncl0yqo6sv.cloudfront.net";
const EVAL_PIM_ORG_SLUG = process.env.EVAL_PIM_ORG_SLUG ?? "adobecom";
const USE_LIVE_KG = process.env.USE_OFFLINE_LEARNINGS !== "1";

let cachedAuthHeader: string | null = null;

async function getAuthHeader(): Promise<string> {
  if (cachedAuthHeader) return cachedAuthHeader;
  assertSecurePermissions();
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      "USE_OFFLINE_LEARNINGS=0 (default) but no credentials at ~/.pim/credentials.json. Run `pim login` or call MCP `authenticate`, or rerun with USE_OFFLINE_LEARNINGS=1 to use the offline shim.",
    );
  }
  const fresh = await ensureFreshToken(creds);
  cachedAuthHeader = `Bearer ${fresh.access_token}`;
  return cachedAuthHeader;
}

async function fetchLiveLearnings(podId: string, queryText?: string): Promise<FixtureLearnings> {
  // Uses POST /api/knowledge/query (not GET /api/knowledge/relevant) because
  // the convenience endpoint hard-codes include_details=false (server's
  // knowledge-graph.ts:424). For the eval we want the same rich detail text
  // that a hand-curated shim provided. Production pod agents currently get
  // summary-only via the SDK; that's an orthogonal concern tracked separately.
  const pod = demoPods[podId];
  const scopes = Array.from(new Set((pod?.areas ?? []).map((a) => a.scope)));
  const domains = scopes.length > 0 ? scopes : ["frontend", "backend"];
  const projectId = pod?.project_id?.trim();

  const auth = await getAuthHeader();
  const res = await fetch(`${EVAL_PIM_BASE_URL}/api/knowledge/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
      "X-Pim-Org": EVAL_PIM_ORG_SLUG,
    },
    body: JSON.stringify({
      filters: {
        domains,
        ...(projectId ? { include_project_id: projectId } : {}),
      },
      max_tokens: 4000,
      include_details: true,
      ...(queryText?.trim() ? { query_text: queryText.trim() } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(
      `POST /api/knowledge/query for pod ${podId} failed: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as {
    nodes: Array<{
      type: string;
      summary: string;
      details: string;
      domains: string[];
      confidence_score: number;
      source_pod_name?: string;
      created_at?: string;
    }>;
    total_matching: number;
    truncated: boolean;
  };
  return {
    nodes: body.nodes.map((n) => ({
      type: n.type,
      summary: n.summary,
      details: n.details,
      domains: n.domains,
      confidence_score: n.confidence_score,
      source_pod_name: n.source_pod_name,
      created_at: n.created_at,
    })),
    total_matching: body.total_matching,
    truncated: body.truncated,
  };
}

function compactForKgQuery(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 3500);
}

function buildTaskKgQuery(task: Task): string {
  const promptWithoutCode = task.prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\n# Output[\s\S]*$/i, "\n")
    .replace(/\n# Current source[\s\S]*$/i, "\n");
  const parts = [
    `Task: ${task.id}`,
    task.tags?.length ? `Tags: ${task.tags.join(", ")}` : "",
    task.expectedSignals?.length ? `Expected signals: ${task.expectedSignals.join(", ")}` : "",
    promptWithoutCode,
  ];
  return compactForKgQuery(parts.filter(Boolean).join("\n"));
}

const TASK_KG_STOP_WORDS = new Set([
  "against",
  "after",
  "before",
  "current",
  "diff",
  "file",
  "fix",
  "from",
  "issue",
  "only",
  "output",
  "prompt",
  "return",
  "source",
  "task",
  "that",
  "this",
  "tsx",
  "typescript",
  "with",
]);

function taskKeywords(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !TASK_KG_STOP_WORDS.has(w)),
  );
}

function filterTaskLearnings(learnings: FixtureLearnings, queryText: string): FixtureLearnings {
  const queryKeywords = taskKeywords(queryText);
  if (queryKeywords.size === 0) return { ...learnings, nodes: [], total_matching: 0, truncated: false };

  const nodes = learnings.nodes.filter((node) => {
    const nodeKeywords = taskKeywords(`${node.summary} ${node.details}`);
    let overlap = 0;
    for (const kw of nodeKeywords) {
      if (queryKeywords.has(kw)) overlap++;
    }
    return overlap >= 3;
  });

  return {
    ...learnings,
    nodes,
    total_matching: nodes.length,
    truncated: false,
  };
}

function latestIso(...values: Array<string | null | undefined>): string {
  const parsed = values
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (parsed.length === 0) return "1970-01-01T00:00:00.000Z";
  return new Date(Math.max(...parsed)).toISOString();
}

function splitLivingDocSections(podId: string, markdown: string): LivingDocSection[] {
  const pod = demoPods[podId];
  const conflicts = demoConflicts[podId] ?? [];
  const updates = demoUpdates[podId] ?? [];
  const areaUpdates = (pod?.areas ?? []).map((area) => area.last_activity);
  const latestActivity = latestIso(
    ...areaUpdates,
    ...conflicts.map((conflict) => conflict.created_at),
    ...updates.map((update) => update.timestamp),
  );
  const latestConflict = latestIso(...conflicts.map((conflict) => conflict.created_at));
  const latestUpdate = latestIso(...updates.map((update) => update.timestamp));
  const sprintStart = pod?.sprint_start ? `${pod.sprint_start}T00:00:00.000Z` : latestActivity;

  const timestampForHeading = (heading: string): string => {
    const normalized = heading.toLowerCase();
    if (normalized.includes("open conflict")) return latestConflict;
    if (normalized.includes("context stream")) return latestUpdate;
    if (normalized.includes("decision")) return latestUpdate;
    if (normalized.includes("current status")) return latestIso(...areaUpdates);
    if (normalized.includes("active milestone")) return latestIso(...areaUpdates);
    if (normalized.includes("pod health")) return latestActivity;
    if (normalized.includes("active tunnel")) return latestActivity;
    if (normalized.includes("cross-pod")) return latestActivity;
    return sprintStart;
  };

  const lines = markdown.split(/\r?\n/);
  const sections: LivingDocSection[] = [];
  let currentHeading = "Document";
  let current: string[] = [];

  const flush = (): void => {
    const body = current.join("\n").trim();
    if (!body) return;
    sections.push({
      heading: currentHeading,
      markdown: body,
      updated_at: timestampForHeading(currentHeading),
      source: `demo-seed:${podId}:living-doc:${currentHeading}`,
    });
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      currentHeading = heading[2];
      current = [line];
      continue;
    }
    current.push(line);
  }
  flush();
  return sections;
}

async function main(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const podsToFreeze = process.argv.slice(2).length > 0 ? process.argv.slice(2) : POD_IDS;
  const runnableTasks = applyAssignmentsToAll(ALL_TASKS).filter((t) => !t.excluded);

  console.log(
    USE_LIVE_KG
      ? `[freeze] live KG: ${EVAL_PIM_BASE_URL} org=${EVAL_PIM_ORG_SLUG}`
      : "[freeze] offline shim (USE_OFFLINE_LEARNINGS=1)",
  );

  for (const podId of podsToFreeze) {
    const pod = demoPods[podId];
    if (!pod) {
      console.warn(`[freeze] pod ${podId} not found in demo seed — skipping`);
      continue;
    }

    let learnings: FixtureLearnings;
    if (USE_LIVE_KG) {
      try {
        learnings = await fetchLiveLearnings(podId);
        console.log(`[freeze]   live learnings for ${podId}: ${learnings.nodes.length} (matching ${learnings.total_matching})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[freeze]   live KG fetch failed for ${podId} (${msg}) — falling back to offline shim`);
        learnings = getCuratedLearnings(podId);
      }
    } else {
      learnings = getCuratedLearnings(podId);
    }

    const taskRelevantLearnings: Record<string, FixtureLearnings> = {};
    const podTasks = runnableTasks.filter((t) => t.podId === podId);
    for (const task of podTasks) {
      const taskQuery = buildTaskKgQuery(task);
      if (USE_LIVE_KG) {
        try {
          const taskLearnings = filterTaskLearnings(
            await fetchLiveLearnings(podId, taskQuery),
            taskQuery,
          );
          taskRelevantLearnings[task.id] = taskLearnings;
          console.log(
            `[freeze]   task learnings for ${task.id}: ${taskLearnings.nodes.length} (matching ${taskLearnings.total_matching})`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[freeze]   task KG fetch failed for ${task.id} (${msg}) — using pod-level fallback`);
        }
      } else {
        taskRelevantLearnings[task.id] = filterTaskLearnings(getCuratedLearnings(podId), taskQuery);
      }
    }

    const fixture: SessionContextFixture = {
      podId,
      pulledAt: new Date().toISOString(),
      sourceOrgSlug: EVAL_PIM_ORG_SLUG,
      payload: {
        pod: {
          pod_id: pod.pod_id,
          name: pod.name,
          milestone: pod.milestone ? { name: pod.milestone.name } : undefined,
          conflict_pressure: pod.conflict_pressure,
          areas: pod.areas,
        },
        livingDocMarkdown: demoLivingDocs[podId] ?? "(no living doc)",
        livingDocSections: splitLivingDocSections(podId, demoLivingDocs[podId] ?? "(no living doc)"),
        conflicts: (demoConflicts[podId] ?? []).map((c) => ({
          id: c.id,
          created_at: c.created_at,
          summary: c.summary,
          severity: c.severity,
          status: c.status,
          sides: c.sides.map((s) => ({ contributor: s.contributor, position: s.position })),
          master_analysis: c.master_analysis,
          impact: c.impact,
        })),
        relevantLearnings: learnings,
        ...(Object.keys(taskRelevantLearnings).length > 0 ? { taskRelevantLearnings } : {}),
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
