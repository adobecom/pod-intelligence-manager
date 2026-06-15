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
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadCredentials, ensureFreshToken, assertSecurePermissions } from "@pim/shared/auth";
import {
  formatKgLeakageFindings,
  hasKgLeakageErrors,
  validateKgCandidatePayload,
  validateKgSourceManifestObject,
  type KgLeakageFinding,
} from "../src/rigor/kg-source-leakage.js";

interface Args {
  in: string;
  org: string;
  apiBase: string;
  dryRun: boolean;
  limit: number | null;
  sourceManifest: string | null;
  experimentManifest: string | null;
  allowDiagnostic: boolean;
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

interface SubmitRecord {
  nodeId?: string;
  summary: string;
  source_label: string;
  status: "created" | "duplicate" | "error";
  httpStatus: number;
  error?: unknown;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    org: "emc-sandbox",
    apiBase: (process.env.PIM_API_URL?.replace(/\/+$/, "") ?? "https://d1ygncl0yqo6sv.cloudfront.net"),
    dryRun: false,
    limit: null,
    sourceManifest: null,
    experimentManifest: null,
    allowDiagnostic: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--": break;
      case "--in": args.in = next; i++; break;
      case "--org": args.org = next; i++; break;
      case "--api-base": args.apiBase = next.replace(/\/+$/, ""); i++; break;
      case "--dry-run": args.dryRun = true; break;
      case "--limit": args.limit = Number(next); i++; break;
      case "--source-manifest": args.sourceManifest = resolve(next); i++; break;
      case "--experiment-manifest": args.experimentManifest = resolve(next); i++; break;
      case "--allow-diagnostic": args.allowDiagnostic = true; break;
      case "--help":
        console.log(`Usage: pnpm --filter @pim/eval kg-submit -- --in <classified.json> [flags]

Flags:
  --in <path>                    Classified candidates JSON from classify-candidates.ts
  --org <slug>                   Target graph org. Default: emc-sandbox
  --api-base <url>               PIM API base. Default: PIM_API_URL or hosted sandbox
  --dry-run                      Validate and print nodes without submitting
  --limit <n>                    Submit only the first n kept nodes
  --source-manifest <path>       Claimable KG source manifest to validate against
  --experiment-manifest <path>   Output ledger with created node IDs for rollback
  --allow-diagnostic             Permit leakage errors for non-claimable ablations
`);
        process.exit(0);
      default:
        if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!args.in) throw new Error("--in is required");
  return args as Args;
}

async function validateInputs(params: {
  kept: ClassifiedNode[];
  sourceManifest: string | null;
}): Promise<KgLeakageFinding[]> {
  const findings: KgLeakageFinding[] = [];
  if (params.sourceManifest) {
    const manifest = JSON.parse(await readFile(params.sourceManifest, "utf8")) as Parameters<typeof validateKgSourceManifestObject>[0];
    findings.push(...validateKgSourceManifestObject(manifest));
  }
  for (const node of params.kept) {
    findings.push(...validateKgCandidatePayload(node));
  }
  return findings;
}

function normalizeSourceLabel(label: string): string {
  if (label.length <= 120) return label;
  const hash = createHash("sha1").update(label).digest("hex").slice(0, 8);
  return `${label.slice(0, 111)}#${hash}`;
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
  if (args.sourceManifest) console.log(`[submit] source-manifest=${args.sourceManifest}`);
  if (args.experimentManifest) console.log(`[submit] experiment-manifest=${args.experimentManifest}`);

  const leakageFindings = await validateInputs({ kept, sourceManifest: args.sourceManifest });
  if (leakageFindings.length > 0) console.log(formatKgLeakageFindings(leakageFindings));
  if (hasKgLeakageErrors(leakageFindings) && !args.allowDiagnostic) {
    throw new Error("KG submit input contains eval-leakage errors; pass --allow-diagnostic only for non-claimable ablations");
  }

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
  const records: SubmitRecord[] = [];
  for (const node of kept) {
    const sourceLabel = normalizeSourceLabel(node.source_label);
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
        source_label: sourceLabel,
      }),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* leave */ }

    if (res.status === 200 || res.status === 201) {
      const id = (body as { nodeId?: string }).nodeId;
      console.log(`[submit] ${id ?? "(no id)"} — ${node.summary.slice(0, 70)}…`);
      records.push({
        nodeId: id,
        summary: node.summary,
        source_label: sourceLabel,
        status: "created",
        httpStatus: res.status,
      });
      added++;
    } else if (res.status === 409) {
      console.log(`[submit] DUPLICATE — ${node.summary.slice(0, 70)}…`);
      records.push({
        summary: node.summary,
        source_label: sourceLabel,
        status: "duplicate",
        httpStatus: res.status,
      });
      duplicates++;
    } else {
      console.error(`[submit] FAILED status=${res.status} body=${JSON.stringify(body).slice(0, 200)} for ${sourceLabel}`);
      records.push({
        summary: node.summary,
        source_label: sourceLabel,
        status: "error",
        httpStatus: res.status,
        error: body,
      });
      errors++;
    }
  }
  if (args.experimentManifest) {
    const created = records.filter(
      (record): record is SubmitRecord & { nodeId: string } => record.status === "created" && typeof record.nodeId === "string",
    );
    await mkdir(dirname(args.experimentManifest), { recursive: true });
    await writeFile(
      args.experimentManifest,
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "kg-graph-submit-manifest",
          generatedAt: new Date().toISOString(),
          org: args.org,
          apiBase: args.apiBase,
          input: args.in,
          sourceManifest: args.sourceManifest,
          allowDiagnostic: args.allowDiagnostic,
          leakageFindings,
          created,
          createdNodeIds: created.map((record) => record.nodeId),
          records,
          counts: { added, duplicates, errors },
        },
        null,
        2,
      ),
    );
    console.log(`[submit] wrote ${args.experimentManifest}`);
  }
  console.log(`[submit] done. added=${added} duplicates=${duplicates} errors=${errors}`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[submit] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
