/**
 * Seed / refresh a project's indexed search layer.
 *
 * Backfills `project_search_documents` + chunks (and the FTS5 + entity/edge
 * layers) from a project's existing working memory — evidence items, project
 * context updates, and linked pod context updates — then optionally polls
 * external sources (Jira/GitHub) and embeds chunks.
 *
 * Re-runnable and idempotent. Safe to run with no external credentials: it will
 * simply seed from the working memory already in the DB.
 *
 * Usage:
 *   tsx src/scripts/seed-project-search.ts [projectId] [--org <orgId>] [--poll] [--embed] [--query "..."]
 *   npm --prefix packages/server run seed-project-search -- project-emc --embed
 *
 *   projectId   Project to seed (default: project-emc)
 *   --org       Org id (default: derived from the project row)
 *   --poll      Pull fresh artifacts from configured external sources first
 *               (requires JIRA and GH_TOKEN env + project resources configured)
 *   --embed     Generate chunk embeddings (requires AWS Bedrock creds; rate-limited)
 *   --query     Sample query to run after seeding (default: "RBAC scopes")
 */
import "../load-env.js";
import db from "../db/connection.js";
import { createTables } from "../db/schema.js";
import { pollProjectSources } from "../services/project-memory.js";
import { reindexProjectSearch } from "../services/project-search-index.js";
import { searchProject } from "../services/project-search.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const positional = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const projectId = positional ?? "project-emc";
  const doPoll = process.argv.includes("--poll");
  const doEmbed = process.argv.includes("--embed");
  const doAnswer = process.argv.includes("--answer");
  const sampleQuery = arg("--query") ?? "RBAC scopes";

  createTables();

  const row = db
    .prepare("SELECT project_id, name, org_id FROM projects WHERE project_id = ?")
    .get(projectId) as { project_id: string; name: string; org_id: string | null } | undefined;
  if (!row) {
    console.error(`[seed-project-search] Project not found: ${projectId}`);
    process.exit(1);
  }
  const orgId = arg("--org") ?? row.org_id ?? "";
  if (!orgId) {
    console.error(`[seed-project-search] Project ${projectId} has no org_id; pass --org <orgId>.`);
    process.exit(1);
  }

  console.log(`[seed-project-search] project=${projectId} (${row.name}) org=${orgId} poll=${doPoll} embed=${doEmbed}`);

  if (doPoll) {
    console.log("[seed-project-search] Polling external sources…");
    try {
      const poll = await pollProjectSources(orgId, projectId);
      for (const r of poll?.results ?? []) {
        console.log(`  ${r.source}: ingested ${r.ingested}${r.missing ? ` (skipped: ${r.missing})` : ""}`);
      }
    } catch (err) {
      console.warn(`  poll failed: ${(err as Error).message}`);
    }
  }

  const stats = await reindexProjectSearch(orgId, projectId, { embed: doEmbed });
  console.log("[seed-project-search] Index stats:");
  console.log(`  documents: ${stats.documents_indexed}`);
  console.log(`  chunks:    ${stats.chunks_indexed}`);
  console.log(`  entities:  ${stats.entities_indexed}`);
  console.log(`  edges:     ${stats.edges_indexed}`);
  console.log(`  embedded:  ${stats.chunks_embedded}${stats.embedding_available ? "" : " (embedding service unavailable)"}`);

  console.log(`\n[seed-project-search] Sample query: "${sampleQuery}"`);
  const res = await searchProject(orgId, projectId, {
    query: sampleQuery,
    include_kg: false,
    max_hits: 6,
    synthesize: doAnswer,
  });
  if (!res || res.hits.length === 0) {
    console.log("  (no hits)");
  } else {
    if (res.summary_md) {
      console.log("\n  ── Answer ──");
      console.log(res.summary_md.split("\n").map((l) => `  ${l}`).join("\n"));
      console.log("  ────────────");
    }
    console.log(`\n  ${res.hits.length} hit(s) · ${res.retrieval_mode} · sources: ${res.sources_used.join(", ")}`);
    res.hits.forEach((h, i) => {
      console.log(`  [${i + 1}] (${h.source}/${h.source_type}) ${h.title}`);
    });
  }
}

main().catch((err) => {
  console.error("[seed-project-search] Failed:", err);
  process.exit(1);
});
