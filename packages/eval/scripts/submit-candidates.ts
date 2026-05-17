/**
 * Stage 3 of the T3-events sandbox seeding pipeline.
 *
 * Reads classified.json (output of classify-candidates.ts) and POSTs each kept
 * node to the sandbox org's knowledge graph. Idempotent: 409 means a near-
 * duplicate already exists, which we log and skip. Anything else non-2xx
 * surfaces as an error.
 *
 * The default target is the emc-sandbox org on the hosted PIM instance. To
 * point at a different org, set PIM_API_URL and pass --org <slug>.
 *
 * Usage:
 *   pnpm exec tsx scripts/submit-candidates.ts \
 *     --in scripts/classified/adobecom-EMC.json
 *
 *   pnpm exec tsx scripts/submit-candidates.ts --in <file> --org emc-sandbox --dry-run
 */

import "../src/load-env.js";
import { readFile } from "node:fs/promises";
import { loadCredentials, ensureFreshToken, assertSecurePermissions } from "@pim/shared/auth";

interface Args {
  in: string;
  org: string;
  apiBase: string;
  dryRun: boolean;
  limit: number | null;
}

interface ClassifiedNode {
  type: "decision" | "pattern" | "anti_pattern" | "resolved_conflict" | "scope_insight";
  summary: string;
  details: string;
  domains: string[];
  confidence_score: number;
  source_label: string;
  source_url: string;
  source_kind: "pr" | "doc";
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    org: "emc-sandbox",
    apiBase: (process.env.PIM_API_URL?.replace(/\/+$/, "") ?? "https://d1ygncl0yqo6sv.cloudfront.net"),
    dryRun: false,
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--in": args.in = next; i++; break;
      case "--org": args.org = next; i++; break;
      case "--api-base": args.apiBase = next.replace(/\/+$/, ""); i++; break;
      case "--dry-run": args.dryRun = true; break;
      case "--limit": args.limit = Number(next); i++; break;
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!args.in) throw new Error("--in is required");
  return args as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(args.in, "utf8")) as {
    repo: string;
    host: string;
    kept: ClassifiedNode[];
  };
  let kept = raw.kept;
  if (args.limit) kept = kept.slice(0, args.limit);
  console.log(`[submit] in=${args.in} repo=${raw.repo} nodes=${kept.length} target=${args.apiBase} org=${args.org}${args.dryRun ? " DRY-RUN" : ""}`);

  if (args.dryRun) {
    for (const n of kept) {
      console.log(`  [${n.type}] ${n.summary.slice(0, 90)} (from ${n.source_label})`);
    }
    return;
  }

  assertSecurePermissions();
  const creds = loadCredentials();
  if (!creds) throw new Error("No credentials at ~/.pim/credentials.json. Run authenticate first.");
  const fresh = await ensureFreshToken(creds);

  let added = 0;
  let duplicates = 0;
  let errors = 0;
  for (const node of kept) {
    const res = await fetch(`${args.apiBase}/api/knowledge/nodes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fresh.access_token}`,
        "X-Pim-Org": args.org,
      },
      body: JSON.stringify({
        type: node.type,
        summary: node.summary,
        details: node.details,
        domains: node.domains,
        confidence_score: node.confidence_score,
        source_label: node.source_label,
      }),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* leave */ }

    if (res.status === 200 || res.status === 201) {
      const id = (body as { nodeId?: string }).nodeId ?? "(no id)";
      console.log(`[submit] ${id} — ${node.summary.slice(0, 70)}…`);
      added++;
    } else if (res.status === 409) {
      console.log(`[submit] DUPLICATE — ${node.summary.slice(0, 70)}…`);
      duplicates++;
    } else {
      console.error(`[submit] FAILED status=${res.status} body=${JSON.stringify(body).slice(0, 200)} for ${node.source_label}`);
      errors++;
    }
  }
  console.log(`[submit] done. added=${added} duplicates=${duplicates} errors=${errors}`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[submit] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
