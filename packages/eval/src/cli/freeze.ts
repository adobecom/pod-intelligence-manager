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
const PIM_SERVICE_TOKEN = process.env.PIM_SERVICE_TOKEN?.trim();
const USE_LIVE_KG = process.env.USE_OFFLINE_LEARNINGS !== "1";
const KG_SOURCE = parseKgSource(process.env.EVAL_PIM_KG_SOURCE);
const KG_CONTRACT_MODE = parseKgContractMode(process.env.EVAL_PIM_KG_CONTRACT_MODE);

interface OrgConfig {
  scopes: Array<{ id: string; label: string }>;
  kg_context_contract?: "legacy" | "shadow" | "task_relevant";
}

function parseKgSource(raw: string | undefined): "query" | "relevant" {
  const value = raw?.trim() || "query";
  if (value === "query" || value === "relevant") return value;
  throw new Error("EVAL_PIM_KG_SOURCE must be one of: query, relevant");
}

function parseKgContractMode(raw: string | undefined): OrgConfig["kg_context_contract"] | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === "legacy" || value === "shadow" || value === "task_relevant") return value;
  throw new Error("EVAL_PIM_KG_CONTRACT_MODE must be one of: legacy, shadow, task_relevant");
}

let cachedAuthHeader: string | null = null;

async function getAuthHeader(): Promise<string> {
  if (cachedAuthHeader) return cachedAuthHeader;
  if (PIM_SERVICE_TOKEN) {
    cachedAuthHeader = `Bearer ${PIM_SERVICE_TOKEN}`;
    return cachedAuthHeader;
  }
  assertSecurePermissions();
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      "USE_OFFLINE_LEARNINGS=0 (default) but no PIM_SERVICE_TOKEN and no credentials at ~/.pim/credentials.json. Run `pim login`, set PIM_SERVICE_TOKEN, or rerun with USE_OFFLINE_LEARNINGS=1 to use the offline shim.",
    );
  }
  const fresh = await ensureFreshToken(creds);
  cachedAuthHeader = `Bearer ${fresh.access_token}`;
  return cachedAuthHeader;
}

async function fetchOrgConfig(): Promise<OrgConfig> {
  const auth = await getAuthHeader();
  const res = await fetch(`${EVAL_PIM_BASE_URL}/api/org/config`, {
    headers: {
      Authorization: auth,
      "X-Pim-Org": EVAL_PIM_ORG_SLUG,
    },
  });
  if (!res.ok) {
    throw new Error(`GET /api/org/config failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as OrgConfig;
}

async function patchOrgConfig(config: OrgConfig): Promise<OrgConfig> {
  const auth = await getAuthHeader();
  const res = await fetch(`${EVAL_PIM_BASE_URL}/api/org/config`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
      "X-Pim-Org": EVAL_PIM_ORG_SLUG,
    },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/org/config failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as OrgConfig;
}

async function withTemporaryKgContract<T>(fn: () => Promise<T>): Promise<T> {
  if (!USE_LIVE_KG || KG_SOURCE !== "relevant" || !KG_CONTRACT_MODE) {
    return fn();
  }

  const original = await fetchOrgConfig();
  const originalMode = original.kg_context_contract ?? "legacy";
  if (originalMode === KG_CONTRACT_MODE) {
    console.log(`[freeze] org kg_context_contract already ${KG_CONTRACT_MODE}`);
    return fn();
  }
  if (PIM_SERVICE_TOKEN) {
    throw new Error(
      "PIM_SERVICE_TOKEN mode cannot PATCH /api/org/config. Set EVAL_PIM_KG_CONTRACT_MODE out of band with human admin auth, or unset EVAL_PIM_KG_CONTRACT_MODE for this freeze.",
    );
  }

  console.log(`[freeze] temporarily setting kg_context_contract ${originalMode} -> ${KG_CONTRACT_MODE}`);
  await patchOrgConfig({ ...original, kg_context_contract: KG_CONTRACT_MODE });
  try {
    return await fn();
  } finally {
    console.log(`[freeze] restoring kg_context_contract ${KG_CONTRACT_MODE} -> ${originalMode}`);
    await patchOrgConfig({ ...original, kg_context_contract: originalMode });
  }
}

async function fetchLiveLearnings(podId: string, queryText?: string): Promise<FixtureLearnings> {
  // `query` preserves the historical fixture shape with details. `relevant`
  // uses the same contract-aware path as the SDK / pod-agent context bundle.
  const pod = demoPods[podId];
  const scopes = Array.from(new Set((pod?.areas ?? []).map((a) => a.scope)));
  const domains = scopes.length > 0 ? scopes : ["frontend", "backend"];
  const projectId = pod?.project_id?.trim();

  const auth = await getAuthHeader();
  if (KG_SOURCE === "relevant") {
    const url = new URL(`${EVAL_PIM_BASE_URL}/api/knowledge/relevant`);
    url.searchParams.set("scopes", domains.join(","));
    url.searchParams.set("maxTokens", "4000");
    if (projectId) url.searchParams.set("projectId", projectId);
    if (queryText?.trim()) url.searchParams.set("taskQuery", queryText.trim());

    const res = await fetch(url, {
      headers: {
        Authorization: auth,
        "X-Pim-Org": EVAL_PIM_ORG_SLUG,
      },
    });
    if (!res.ok) {
      throw new Error(
        `GET /api/knowledge/relevant for pod ${podId} failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as {
      nodes: Array<{
        type: string;
        summary: string;
        details?: string;
        domains: string[];
        confidence_score: number;
        source_pod_name?: string;
        created_at?: string;
      }>;
      total_matching: number;
      truncated: boolean;
      context_contract?: FixtureLearnings["context_contract"];
    };
    return {
      nodes: body.nodes.map((n) => ({
        type: n.type,
        summary: n.summary,
        details: n.details ?? "",
        domains: n.domains,
        confidence_score: n.confidence_score,
        source_pod_name: n.source_pod_name,
        created_at: n.created_at,
      })),
      total_matching: body.total_matching,
      truncated: body.truncated,
      retrieval_source: "context-contract",
      ...(body.context_contract ? { context_contract: body.context_contract } : {}),
    };
  }

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
    retrieval_source: "knowledge-query",
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
      ? `[freeze] live KG: ${EVAL_PIM_BASE_URL} org=${EVAL_PIM_ORG_SLUG} source=${KG_SOURCE}`
      : "[freeze] offline shim (USE_OFFLINE_LEARNINGS=1)",
  );

  await withTemporaryKgContract(async () => {
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
        const contract = learnings.context_contract
          ? ` contract=${learnings.context_contract.mode}/${learnings.context_contract.returned_mode}`
          : "";
        console.log(`[freeze]   live learnings for ${podId}: ${learnings.nodes.length} (matching ${learnings.total_matching})${contract}`);
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
          const taskLearnings = await fetchLiveLearnings(podId, taskQuery);
          taskRelevantLearnings[task.id] = taskLearnings;
          const contract = taskLearnings.context_contract
            ? ` contract=${taskLearnings.context_contract.mode}/${taskLearnings.context_contract.returned_mode}`
            : "";
          console.log(
            `[freeze]   task learnings for ${task.id}: ${taskLearnings.nodes.length} (matching ${taskLearnings.total_matching})${contract}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[freeze]   task KG fetch failed for ${task.id} (${msg}) — using pod-level fallback`);
        }
      } else {
        taskRelevantLearnings[task.id] = {
          ...getCuratedLearnings(podId),
          retrieval_source: "offline",
        };
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
  });
}

main().catch((err) => {
  console.error("[freeze] failed:", err);
  process.exit(1);
});
