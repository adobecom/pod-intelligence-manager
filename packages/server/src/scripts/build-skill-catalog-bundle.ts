/**
 * Build a portable skill-catalog snapshot from a GitHub repository on the
 * machine running this command. The hosted PIM never needs repository access:
 * upload the resulting bundle through the catalog import route.
 *
 * The build uses an isolated temporary SQLite database and never writes
 * repository credentials or unredacted skill bodies to the bundle.
 *
 * Usage:
 *   npm --prefix packages/server run skill-catalog:bundle -- \
 *     --credential-alias MIMIR_GITHUB_TOKEN --embed
 *
 * Defaults target Adobe-acom/mimir and write to:
 *   .data/exports/mimir-main.skill-catalog.json
 */
import "../load-env.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillCatalogLayoutRule } from "@pim/shared/skill-catalog";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function args(flag: string): string[] {
  const values: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

function parseLayoutRules(): SkillCatalogLayoutRule[] {
  const configured = args("--layout");
  if (configured.length === 0) {
    return [
      {
        glob: "projects/*/skills/**/*.md",
        namespace: "project:{1}",
      },
      { glob: "shared/skills/**/*.md", namespace: "shared" },
    ];
  }
  return configured.map((value) => {
    const separator = value.lastIndexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(
        `Invalid --layout ${value}; expected <glob>=<namespace>`,
      );
    }
    return {
      glob: value.slice(0, separator),
      namespace: value.slice(separator + 1),
    };
  });
}

async function main(): Promise<void> {
  const sourceId = arg("--source-id") ?? "mimir-main";
  const displayName = arg("--display-name") ?? "Mimir";
  const apiBaseUrl = arg("--api-base-url") ?? "https://api.github.com";
  const owner = arg("--owner") ?? "Adobe-acom";
  const repo = arg("--repo") ?? "mimir";
  const defaultRef = arg("--ref") ?? "main";
  const credentialAlias =
    arg("--credential-alias") ?? "MIMIR_GITHUB_TOKEN";
  const doEmbed = process.argv.includes("--embed");
  const outputPath = path.resolve(
    arg("--output") ??
      path.join(
        repoRoot,
        ".data",
        "exports",
        `${sourceId}.skill-catalog.json`,
      ),
  );
  const layoutRules = parseLayoutRules();
  const excludeGlobs =
    args("--exclude").length > 0
      ? args("--exclude")
      : ["projects/*/skills/**/context-*.md"];

  if (!process.env[credentialAlias]?.trim()) {
    throw new Error(
      `Credential alias ${credentialAlias} is not configured in the environment`,
    );
  }

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pim-skill-catalog-build-"),
  );
  process.env.DB_PATH = path.join(tempDir, "pim.db");

  let closeDb: (() => void) | undefined;
  try {
    const [{ default: db }, { createTables }, catalog, search, portable] =
      await Promise.all([
        import("../db/connection.js"),
        import("../db/schema.js"),
        import("../services/skill-catalog.js"),
        import("../services/skill-catalog-search.js"),
        import("../services/skill-catalog-bundle.js"),
      ]);
    closeDb = () => db.close();
    createTables();

    const now = new Date().toISOString();
    const userId = "portable-catalog-builder";
    const orgId = "portable-catalog-org";
    db.prepare(
      "INSERT INTO users (user_id, email, created_at) VALUES (?, ?, ?)",
    ).run(userId, "portable-catalog-builder@local.invalid", now);
    db.prepare(
      `INSERT INTO orgs
         (org_id, slug, name, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(orgId, orgId, "Portable catalog build", userId, now);

    catalog.createSkillCatalogSource(orgId, {
      sourceId,
      displayName,
      apiBaseUrl,
      owner,
      repo,
      defaultRef,
      layoutRules,
      excludeGlobs,
      credentialAlias,
    });

    process.stdout.write(
      `[skill-catalog-bundle] Building ${owner}/${repo}@${defaultRef} locally\n`,
    );
    const result = await catalog.syncSkillCatalogSource(orgId, sourceId);
    if (result.state === "failed") {
      throw new Error(result.error ?? "Catalog snapshot build failed");
    }

    if (doEmbed) {
      process.stdout.write(
        "[skill-catalog-bundle] Generating secret-redacted search embeddings\n",
      );
      const embedded = await search.runSkillCatalogEmbeddingBackfill();
      if (!embedded.available) {
        throw new Error(
          "Embedding service is unavailable; omit --embed for a deterministic-only conflict index",
        );
      }
      if (embedded.failed > 0) {
        throw new Error(
          `${embedded.failed} catalog embedding(s) failed; rerun after fixing the embedding service`,
        );
      }
    }

    const bundle = portable.exportSkillCatalogBundle({
      orgId,
      sourceId,
      commitSha: result.snapshot.commitSha,
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(bundle)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const bytes = fs.statSync(outputPath).size;
    process.stdout.write(
      [
        "[skill-catalog-bundle] Bundle ready",
        `  path:       ${outputPath}`,
        `  commit:     ${bundle.snapshot.commitSha}`,
        `  state:      ${bundle.snapshot.state}`,
        `  entries:    ${bundle.snapshot.entryCount}`,
        `  blobs:      ${bundle.snapshot.blobCount}`,
        `  dimensions: ${bundle.snapshot.embeddingDimensions ?? "none"}`,
        `  bytes:      ${bytes}`,
        `  sha256:     ${bundle.integrity.digest}`,
        "",
      ].join("\n"),
    );
  } finally {
    closeDb?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `[skill-catalog-bundle] Failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});

