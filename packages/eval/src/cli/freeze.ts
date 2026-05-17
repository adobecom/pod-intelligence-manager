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
import type { SessionContextFixture } from "../arms/types.js";
import { getCuratedLearnings } from "./curated-learnings.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = join(dirname(__filename), "..", "..", "fixtures", "session-contexts");

const POD_IDS = ["pod-emc-rbac", "pod-emc-sessions", "pod-emc-configs"];

// Sandbox KG retrieval. Set USE_OFFLINE_LEARNINGS=1 to skip the HTTP call and
// fall back to the hand-curated shim (useful when offline or when comparing
// the offline baseline against the live-retrieval result).
const EVAL_PIM_BASE_URL =
  process.env.EVAL_PIM_BASE_URL?.replace(/\/+$/, "") ??
  "https://d1ygncl0yqo6sv.cloudfront.net";
const EVAL_PIM_ORG_SLUG = process.env.EVAL_PIM_ORG_SLUG ?? "emc-sandbox";
const USE_LIVE_KG = process.env.USE_OFFLINE_LEARNINGS !== "1";

interface LiveLearningNode {
  type: string;
  summary: string;
  details: string;
  domains: string[];
  confidence_score: number;
  source_pod_name?: string;
}

interface FixtureLearnings {
  nodes: LiveLearningNode[];
  total_matching: number;
  truncated: boolean;
}

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

async function fetchLiveLearnings(podId: string): Promise<FixtureLearnings> {
  // Uses POST /api/knowledge/query (not GET /api/knowledge/relevant) because
  // the convenience endpoint hard-codes include_details=false (server's
  // knowledge-graph.ts:424). For the eval we want the same rich detail text
  // that a hand-curated shim provided. Production pod agents currently get
  // summary-only via the SDK; that's an orthogonal concern tracked separately.
  const pod = demoPods[podId];
  const milestoneQuery = pod?.milestone?.name?.trim();
  const scopes = Array.from(new Set((pod?.areas ?? []).map((a) => a.scope)));
  const domains = scopes.length > 0 ? scopes : ["frontend", "backend"];

  const auth = await getAuthHeader();
  const res = await fetch(`${EVAL_PIM_BASE_URL}/api/knowledge/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
      "X-Pim-Org": EVAL_PIM_ORG_SLUG,
    },
    body: JSON.stringify({
      filters: { domains },
      max_tokens: 4000,
      include_details: true,
      ...(milestoneQuery ? { query_text: milestoneQuery } : {}),
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
    })),
    total_matching: body.total_matching,
    truncated: body.truncated,
  };
}

async function main(): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const podsToFreeze = process.argv.slice(2).length > 0 ? process.argv.slice(2) : POD_IDS;

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
        relevantLearnings: learnings,
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
