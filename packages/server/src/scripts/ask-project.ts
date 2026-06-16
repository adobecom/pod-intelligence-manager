/**
 * Ask a question about a project from the command line (read-only; no server).
 *
 *   tsx src/scripts/ask-project.ts <projectId> <question...> [--no-answer] [--raw]
 *
 * Runs the hybrid project search and (by default) a plain-language synthesized
 * answer. Useful for local verification without standing up the API.
 */
import "../load-env.js";
import db from "../db/connection.js";
import { searchProject } from "../services/project-search.js";

async function main() {
  const args = process.argv.slice(2);
  const projectId = args.find((a) => !a.startsWith("--")) ?? "project-emc";
  const query = args.filter((a) => !a.startsWith("--") && a !== projectId).join(" ");
  const synthesize = !args.includes("--no-answer");
  const raw = args.includes("--raw");
  if (!query) {
    console.error("Usage: tsx src/scripts/ask-project.ts <projectId> <question...>");
    process.exit(1);
  }
  const row = db.prepare("SELECT org_id FROM projects WHERE project_id = ?").get(projectId) as { org_id: string | null } | undefined;
  if (!row?.org_id) {
    console.error(`Project not found (or has no org): ${projectId}`);
    process.exit(1);
  }
  const res = await searchProject(row.org_id, projectId, {
    query,
    synthesize,
    include_kg: true,
    include_mind_map: true,
    max_hits: 8,
  });
  if (!res) {
    console.error("Project not found");
    process.exit(1);
  }
  if (raw) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`\nQ: ${query}\n`);
  if (res.summary_md) {
    console.log(res.summary_md);
    if (res.answer_citations?.length) {
      console.log("\n── answer evidence ──");
      for (const c of res.answer_citations.slice(0, 8)) {
        console.log(`  [${c.ref}] ${c.source}: ${c.title}${c.url ? ` — ${c.url}` : ""}`);
      }
    }
    console.log("\n── sources ──");
  }
  console.log(
    `${res.hits.length} hit(s) · ${res.retrieval_mode} · embedding coverage ${(res.embedding_coverage * 100).toFixed(0)}% · sources: ${res.sources_used.join(", ")}`,
  );
  res.hits.forEach((h, i) => {
    const when = h.occurred_at ? ` (${h.occurred_at.slice(0, 10)})` : "";
    console.log(`  [${i + 1}] ${h.source}/${h.source_type}${h.status ? ` [${h.status}]` : ""}: ${h.title}${when}`);
  });
  if (res.mind_map) console.log(`\nmind-map: ${res.mind_map.entities.length} entities, ${res.mind_map.edges.length} edges`);
  if (res.kg_overlay?.length) console.log(`KG overlay: ${res.kg_overlay.length} node(s)`);
}

main().catch((err) => {
  console.error("ask-project failed:", err);
  process.exit(1);
});
