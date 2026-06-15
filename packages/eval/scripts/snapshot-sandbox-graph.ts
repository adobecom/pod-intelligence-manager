/**
 * Snapshots an org-scoped knowledge graph before a KG rebuild experiment.
 *
 * Usage:
 *   pnpm --filter @pim/eval kg-snapshot -- --org emc-sandbox --out runs/kg-rebuild/before.json
 */

import "../src/load-env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadCredentials, ensureFreshToken, assertSecurePermissions } from "@pim/shared/auth";

interface Args {
  org: string;
  apiBase: string;
  out: string;
  includeEmbeddings: boolean;
}

function parseArgs(argv: string[]): Args {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const args: Args = {
    org: "emc-sandbox",
    apiBase: process.env.PIM_API_URL?.replace(/\/+$/, "") ?? "https://d1ygncl0yqo6sv.cloudfront.net",
    out: resolve("runs", `kg-rebuild-${stamp}`, "graph-before.json"),
    includeEmbeddings: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--":
        break;
      case "--org":
        args.org = next;
        i++;
        break;
      case "--api-base":
        args.apiBase = next.replace(/\/+$/, "");
        i++;
        break;
      case "--out":
        args.out = resolve(next);
        i++;
        break;
      case "--no-embeddings":
        args.includeEmbeddings = false;
        break;
      case "--help":
        console.log("Usage: pnpm --filter @pim/eval kg-snapshot -- --org emc-sandbox --out runs/kg-rebuild/before.json");
        process.exit(0);
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertSecurePermissions();
  const creds = loadCredentials();
  if (!creds) throw new Error("No credentials at ~/.pim/credentials.json. Run `pim login`.");
  const fresh = await ensureFreshToken(creds);

  const url = `${args.apiBase}/api/knowledge/graph?include_embeddings=${args.includeEmbeddings ? "true" : "false"}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${fresh.access_token}`,
      "X-Pim-Org": args.org,
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
  }

  const graph = await res.json() as { nodes?: unknown[] };
  const snapshot = {
    schemaVersion: 1,
    kind: "kg-graph-snapshot",
    generatedAt: new Date().toISOString(),
    org: args.org,
    apiBase: args.apiBase,
    includeEmbeddings: args.includeEmbeddings,
    nodeCount: Array.isArray(graph.nodes) ? graph.nodes.length : null,
    graph,
  };

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(snapshot, null, 2));
  console.log(`[kg-snapshot] wrote ${args.out} nodes=${snapshot.nodeCount ?? "unknown"} org=${args.org}`);
}

main().catch((err) => {
  console.error("[kg-snapshot] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
