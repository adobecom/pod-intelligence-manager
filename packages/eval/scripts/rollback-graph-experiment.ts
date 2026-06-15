/**
 * Rejects nodes created by a tracked KG graph experiment.
 *
 * The input manifest is written by submit-candidates.ts when called with
 * --experiment-manifest. Rollback is intentionally narrow: it rejects only
 * node IDs this experiment created.
 *
 * Usage:
 *   pnpm --filter @pim/eval kg-rollback -- --manifest runs/kg-rebuild/submit-manifest.json
 */

import "../src/load-env.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCredentials, ensureFreshToken, assertSecurePermissions } from "@pim/shared/auth";

interface Args {
  manifest: string;
  org?: string;
  apiBase?: string;
  dryRun: boolean;
}

interface ExperimentManifest {
  kind?: string;
  org?: string;
  apiBase?: string;
  created?: Array<{ nodeId: string; summary?: string; source_label?: string }>;
  createdNodeIds?: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { manifest: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--":
        break;
      case "--manifest":
        args.manifest = resolve(next);
        i++;
        break;
      case "--org":
        args.org = next;
        i++;
        break;
      case "--api-base":
        args.apiBase = next.replace(/\/+$/, "");
        i++;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
        console.log("Usage: pnpm --filter @pim/eval kg-rollback -- --manifest runs/kg-rebuild/submit-manifest.json [--dry-run]");
        process.exit(0);
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!args.manifest) throw new Error("--manifest is required");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(args.manifest, "utf8")) as ExperimentManifest;
  const apiBase = (args.apiBase ?? manifest.apiBase ?? process.env.PIM_API_URL ?? "https://d1ygncl0yqo6sv.cloudfront.net").replace(/\/+$/, "");
  const org = args.org ?? manifest.org ?? "emc-sandbox";
  const created = manifest.created ?? (manifest.createdNodeIds ?? []).map((nodeId) => ({ nodeId }));

  if (created.length === 0) {
    console.log("[kg-rollback] manifest has no created nodes; nothing to reject");
    return;
  }

  console.log(`[kg-rollback] manifest=${args.manifest} org=${org} nodes=${created.length}${args.dryRun ? " DRY-RUN" : ""}`);
  for (const item of created) {
    console.log(`  - ${item.nodeId}${item.summary ? ` — ${item.summary.slice(0, 90)}` : ""}`);
  }
  if (args.dryRun) return;

  assertSecurePermissions();
  const creds = loadCredentials();
  if (!creds) throw new Error("No credentials at ~/.pim/credentials.json. Run `pim login`.");
  const fresh = await ensureFreshToken(creds);

  let rejected = 0;
  let errors = 0;
  for (const item of created) {
    const res = await fetch(`${apiBase}/api/knowledge/nodes/${encodeURIComponent(item.nodeId)}/curate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fresh.access_token}`,
        "X-Pim-Org": org,
      },
      body: JSON.stringify({ action: "reject" }),
    });
    if (res.ok) {
      rejected++;
      console.log(`[kg-rollback] rejected ${item.nodeId}`);
    } else {
      errors++;
      console.error(`[kg-rollback] failed ${item.nodeId}: ${res.status} ${await res.text()}`);
    }
  }
  console.log(`[kg-rollback] done rejected=${rejected} errors=${errors}`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[kg-rollback] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
