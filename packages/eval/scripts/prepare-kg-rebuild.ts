/**
 * Builds a leakage-controlled source manifest for a claimable KG rebuild.
 *
 * This does not submit graph nodes. It records the exact source ref, include
 * roots, exclusions, and hashes for the files allowed into graph construction.
 *
 * Usage:
 *   pnpm --filter @pim/eval kg-source-manifest -- \
 *     --source-ref d24a3db \
 *     --out runs/kg-rebuild/source-manifest.json
 */

import "../src/load-env.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIMABLE_KG_DENIED_PATH_PREFIXES,
  CLAIMABLE_KG_DENIED_PATH_SUBSTRINGS,
  CLAIMABLE_KG_DENIED_TEXT_TOKENS,
  CLAIMABLE_KG_EXCLUDE_ROOTS,
  CLAIMABLE_KG_INCLUDE_ROOTS,
  CLAIMABLE_KG_WARNING_TEXT_TOKENS,
  formatKgLeakageFindings,
  hasKgLeakageErrors,
  isUnderAnyRoot,
  normalizeKgSourcePath,
  validateKgSourceFiles,
  type KgLeakageFinding,
} from "../src/rigor/kg-source-leakage.js";

interface Args {
  out: string;
  org: string;
  sourceRef: string;
  workingTree: boolean;
  allowDirty: boolean;
  includeRoots: string[];
  excludeRoots: string[];
  allowOutsideAllowlist: boolean;
}

interface SourceFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const evalRoot = resolve(here, "..");
const repoRoot = resolve(evalRoot, "..", "..");

function parseArgs(argv: string[]): Args {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const args: Args = {
    out: join(evalRoot, "runs", `kg-rebuild-${stamp}`, "source-manifest.json"),
    org: "emc-sandbox",
    sourceRef: "HEAD",
    workingTree: false,
    allowDirty: false,
    includeRoots: [...CLAIMABLE_KG_INCLUDE_ROOTS],
    excludeRoots: [...CLAIMABLE_KG_EXCLUDE_ROOTS],
    allowOutsideAllowlist: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--":
        break;
      case "--out":
        args.out = resolvePath(next);
        i++;
        break;
      case "--org":
        args.org = next;
        i++;
        break;
      case "--source-ref":
        args.sourceRef = next;
        i++;
        break;
      case "--working-tree":
        args.workingTree = true;
        break;
      case "--allow-dirty":
        args.allowDirty = true;
        break;
      case "--include":
        args.includeRoots = splitList(next);
        i++;
        break;
      case "--exclude":
        args.excludeRoots = [...CLAIMABLE_KG_EXCLUDE_ROOTS, ...splitList(next)];
        i++;
        break;
      case "--allow-outside-allowlist":
        args.allowOutsideAllowlist = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return args;
}

function resolvePath(path: string): string {
  return resolve(evalRoot, path);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => normalizeKgSourcePath(part.trim()))
    .filter(Boolean);
}

function printHelp(): void {
  console.log(`Usage: pnpm --filter @pim/eval kg-source-manifest -- [flags]

Flags:
  --out <path>                 Manifest output path. Default: packages/eval/runs/kg-rebuild-*/source-manifest.json
  --org <slug>                 Target graph org label recorded in the manifest. Default: emc-sandbox
  --source-ref <git-ref>       Git ref to hash from. Default: HEAD
  --working-tree               Hash files from the working tree instead of a git ref
  --allow-dirty                Allow --working-tree with uncommitted changes
  --include <a,b,c>            Claimable include roots. Default: product packages + prompts
  --exclude <a,b,c>            Extra exclude roots appended to the default eval/codex/scout exclusions
  --allow-outside-allowlist    Downgrade outside-allowlist warnings for custom source manifests
`);
}

function git(args: string[], options?: { buffer?: false }): Promise<string>;
function git(args: string[], options: { buffer: true }): Promise<Buffer>;
function git(args: string[], options?: { buffer?: boolean }): Promise<string | Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: repoRoot,
        maxBuffer: 100 * 1024 * 1024,
        encoding: options?.buffer ? "buffer" : "utf8",
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(" ")} failed: ${String(stderr).trim() || err.message}`));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function listSourceFiles(args: Args): Promise<string[]> {
  const raw = args.workingTree
    ? await git(["ls-files"])
    : await git(["ls-tree", "-r", "--name-only", args.sourceRef]);
  return String(raw)
    .split(/\r?\n/)
    .map((path) => normalizeKgSourcePath(path.trim()))
    .filter(Boolean)
    .filter((path) => isUnderAnyRoot(path, args.includeRoots))
    .filter((path) => !isUnderAnyRoot(path, args.excludeRoots));
}

async function hashFile(path: string, args: Args): Promise<SourceFileEntry> {
  if (args.workingTree) {
    const abs = join(repoRoot, path);
    const [content, metadata] = await Promise.all([readFile(abs), stat(abs)]);
    return {
      path,
      bytes: metadata.size,
      sha256: sha256(content),
    };
  }

  const content = await git(["show", `${args.sourceRef}:${path}`], { buffer: true });
  return {
    path,
    bytes: content.length,
    sha256: sha256(content),
  };
}

async function hashOptionalGitFile(path: string, args: Args): Promise<string | null> {
  try {
    if (args.workingTree) return sha256(await readFile(join(repoRoot, path)));
    return sha256(await git(["show", `${args.sourceRef}:${path}`], { buffer: true }));
  } catch {
    return null;
  }
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function isDirty(): Promise<boolean> {
  const status = await git(["status", "--short"]);
  return String(status).trim().length > 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceSha = String(await git(["rev-parse", args.sourceRef])).trim();
  const dirty = await isDirty();
  if (args.workingTree && dirty && !args.allowDirty) {
    throw new Error("working tree is dirty; use --source-ref for a frozen ref or pass --allow-dirty for diagnostics");
  }

  const files = await listSourceFiles(args);
  const sourceFiles = await Promise.all(files.map((file) => hashFile(file, args)));
  const findings: KgLeakageFinding[] = validateKgSourceFiles(sourceFiles, {
    includeRoots: args.includeRoots,
    excludeRoots: args.excludeRoots,
  }).filter((finding) => args.allowOutsideAllowlist ? finding.severity === "error" : true);

  const manifest = {
    schemaVersion: 1,
    kind: "kg-source-manifest",
    claimability: hasKgLeakageErrors(findings) ? "diagnostic" : "claimable",
    generatedAt: new Date().toISOString(),
    org: args.org,
    source: {
      repoRoot,
      sourceRef: args.sourceRef,
      gitSha: sourceSha,
      mode: args.workingTree ? "working-tree" : "git-ref",
      gitDirty: dirty,
      allowDirty: args.allowDirty,
    },
    extraction: {
      promptPath: "prompts/knowledge-extraction-agent.md",
      promptHash: await hashOptionalGitFile("prompts/knowledge-extraction-agent.md", args),
      durabilityPromptPath: "prompts/decision-durability-classifier.md",
      durabilityPromptHash: await hashOptionalGitFile("prompts/decision-durability-classifier.md", args),
    },
    policy: {
      includeRoots: args.includeRoots,
      excludeRoots: args.excludeRoots,
      deniedPathPrefixes: [...CLAIMABLE_KG_DENIED_PATH_PREFIXES],
      deniedPathSubstrings: [...CLAIMABLE_KG_DENIED_PATH_SUBSTRINGS],
      deniedTextTokens: [...CLAIMABLE_KG_DENIED_TEXT_TOKENS],
      warningTextTokens: [...CLAIMABLE_KG_WARNING_TEXT_TOKENS],
    },
    files: sourceFiles,
    fileCount: sourceFiles.length,
    totalBytes: sourceFiles.reduce((sum, file) => sum + file.bytes, 0),
    findings,
    ok: !hasKgLeakageErrors(findings),
  };

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(manifest, null, 2));

  console.log(`[kg-source] wrote ${args.out}`);
  console.log(`[kg-source] ref=${args.sourceRef} sha=${sourceSha} files=${sourceFiles.length} dirty=${dirty}`);
  if (findings.length > 0) console.log(formatKgLeakageFindings(findings));
  if (hasKgLeakageErrors(findings)) process.exit(1);
}

main().catch((err) => {
  console.error("[kg-source] error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
