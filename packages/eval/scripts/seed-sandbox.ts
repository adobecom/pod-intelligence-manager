/**
 * Seeds the five EMC-specific facts into the `emc-sandbox` org's knowledge graph.
 *
 * The hosted instance is now org-partitioned (Map<orgId, OrgGraphState>) so
 * writes scoped via `X-Pim-Org: emc-sandbox` land in an isolated graph that
 * does not bleed into the production T3 Events org. Verified by a single-node
 * probe before this script was run.
 *
 * Idempotent: if a near-duplicate already exists the server returns 409 and
 * this script logs and continues.
 *
 * Usage:
 *   cd packages/eval && pnpm exec tsx scripts/seed-sandbox.ts
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

interface SeedNode {
  type: "decision" | "pattern" | "anti_pattern" | "resolved_conflict" | "scope_insight";
  summary: string;
  details: string;
  domains: string[];
  confidence_score: number;
  source_label: string;
}

const SEED_NODES: SeedNode[] = [
  {
    type: "decision",
    summary:
      "ESP event-speaker PUT body contract is { speakerId, speakerType, ordinal, creationTime, modificationTime } and nothing else",
    details:
      "Per ESP OpenAPI, /v1/events/:eventId/speakers/:speakerId PUT accepts only those five fields. Echoing the full GET response (spreading dependentData) fails server-side validation and has been the root cause of repeated 400s on edit. When using callWithDependency's body-builder, fall back to dependentData per-field: body.X ?? dependentData.X. creationTime and modificationTime are server-issued; do not let callers override them. The same pattern applies to all ESP PUTs on speaker resources.",
    domains: ["frontend", "backend"],
    confidence_score: 0.95,
    source_label: "sandbox-seed-event-speaker-put-contract",
  },
  {
    type: "pattern",
    summary:
      "Session-time helpers must return SessionTimeInfo so React state can update without a page refresh",
    details:
      "createSessionTimeForSession and upsertSessionTimeForSession previously returned Promise<void>, which dropped the API's sessionTimeId, creationTime, and modificationTime on the floor. Calling components could not update local state with the new optimistic-concurrency values, so users saw stale data and had to refresh the page after every session-time edit. Fix is to return the API response from both helpers and have handleAddSession / handleUpdateSession capture and propagate sessionTimeId + creationTime + modificationTime into local React session state. This is the EMC-wide convention for any API helper that yields server-issued timestamps.",
    domains: ["frontend"],
    confidence_score: 0.9,
    source_label: "sandbox-seed-session-time-helpers-return-info",
  },
  {
    type: "anti_pattern",
    summary:
      "Spreading a GET response back into an ESP PUT body trips readOnly.openapi.validation",
    details:
      "ESP marks several fields as read-only on PUT (e.g. targetCms on /v1/series/:id). Series unpublish / archive / external-update flows previously echoed the full GET response into the PUT body, which fails ESP's OpenAPI validator with readOnly.openapi.validation. Fix: always filter the payload through the resource-specific prepareEsp*PutPayload helper before PUT. For series use prepareEspSeriesPutPayload (wraps filterSeriesData in 'update' mode). For events use prepareEslEventPutPayload. New ESP PUT endpoints should add a sibling helper in utils/dataFilters.ts before the call site is added.",
    domains: ["frontend"],
    confidence_score: 0.95,
    source_label: "sandbox-seed-esp-put-readonly-anti-pattern",
  },
  {
    // NOTE: typed `pattern`, not `decision`. The server auto-builds a
    // `supersedes` edge between any two `decision` nodes with the same
    // project scope (graph-analysis.ts:158-161), which would hide whichever
    // decision was created first. This is a convention/naming pattern, so
    // `pattern` is also the more accurate type.
    type: "pattern",
    summary:
      "Per-resource PUT payload sanitizers live in utils/dataFilters.ts and follow prepareEsp{Resource}PutPayload naming",
    details:
      "Convention adopted across the EMC frontend: every ESP PUT endpoint has a corresponding prepareEsp{Resource}PutPayload function in web-src/src/utils/dataFilters.ts that calls filterSeriesData (or the resource-specific equivalent) in 'update' mode. This centralizes read-only-field stripping and ensures unpublish, archive, and external-update flows all go through the same validation layer. Do not invent ad-hoc filtering at the call site.",
    domains: ["frontend"],
    confidence_score: 0.9,
    source_label: "sandbox-seed-datafilter-naming-convention",
  },
  {
    type: "pattern",
    summary:
      "ESP resources use modificationTime for optimistic concurrency on PUT; clients must round-trip it",
    details:
      "Every ESP PUT on an updatable resource (event, series, session, speaker) requires the modificationTime field to match the server's last-known value. If they differ, PUT returns 409 with the current server state. Clients must therefore: (a) capture modificationTime on every GET, (b) send it back unchanged on the next PUT, (c) re-fetch on 409 and merge. Dropping or recomputing modificationTime client-side is the most common cause of silent edit failures on EMC.",
    domains: ["frontend", "backend"],
    confidence_score: 0.95,
    source_label: "sandbox-seed-optimistic-concurrency-modtime",
  },
];

async function main(): Promise<void> {
  assertSecurePermissions();
  const creds = loadCredentials();
  if (!creds) throw new Error("No credentials at ~/.pim/credentials.json. Run `pim login`.");
  const fresh = await ensureFreshToken(creds);

  console.log(`[seed] target=${API_BASE} org=${SANDBOX_SLUG}`);
  let added = 0;
  let duplicates = 0;
  let errors = 0;

  for (const node of SEED_NODES) {
    const res = await fetch(`${API_BASE}/api/knowledge/nodes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fresh.access_token}`,
        "X-Pim-Org": SANDBOX_SLUG,
      },
      body: JSON.stringify(node),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* leave as text */ }

    if (res.status === 200 || res.status === 201) {
      const id = (body as { nodeId?: string }).nodeId;
      console.log(`[seed] ${id ?? "(no id)"} — ${node.summary.slice(0, 70)}…`);
      added++;
    } else if (res.status === 409) {
      console.log(`[seed] DUPLICATE — ${node.summary.slice(0, 70)}…`);
      duplicates++;
    } else {
      console.error(`[seed] FAILED status=${res.status} body=${JSON.stringify(body)} for ${node.summary}`);
      errors++;
    }
  }

  console.log(`[seed] done. added=${added} duplicates=${duplicates} errors=${errors}`);

  // Verify retrievability — uses the agent-facing endpoint to make sure the
  // freeze step (which calls the same endpoint) will get the same answers.
  const scopes = encodeURIComponent("frontend,backend");
  const query = encodeURIComponent("ESP PUT contract speakers session-time optimistic concurrency");
  const verifyRes = await fetch(
    `${API_BASE}/api/knowledge/relevant?scopes=${scopes}&maxTokens=4000&query=${query}`,
    {
      headers: {
        Authorization: `Bearer ${fresh.access_token}`,
        "X-Pim-Org": SANDBOX_SLUG,
      },
    },
  );
  if (!verifyRes.ok) {
    console.error(`[seed] verify failed: ${verifyRes.status} ${await verifyRes.text()}`);
    process.exit(1);
  }
  const verifyBody = (await verifyRes.json()) as { nodes: Array<{ id: string; summary: string }> };
  console.log(`[seed] verify (GET /api/knowledge/relevant): ${verifyBody.nodes.length} nodes returned`);
  for (const n of verifyBody.nodes) {
    console.log(`  - ${n.id} — ${n.summary.slice(0, 90)}`);
  }
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[seed] error:", err);
  process.exit(1);
});
