/**
 * Upload a portable skill-catalog bundle to an already configured PIM source.
 *
 * Authentication precedence:
 *   1. PIM_SERVICE_TOKEN
 *   2. PIM_ACCESS_TOKEN
 *   3. the refreshable IMS login at ~/.pim/credentials.json
 *
 * Usage:
 *   npm --prefix packages/server run skill-catalog:upload -- \
 *     .data/exports/mimir-main.skill-catalog.json \
 *     --base-url https://pim.example.com --org adobecom --create-source
 */
import "../load-env.js";
import fs from "node:fs";
import path from "node:path";
import {
  ensureFreshToken,
  loadCredentials,
} from "@pim/shared/auth";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positional(): string | undefined {
  const valueFlags = new Set([
    "--base-url",
    "--org",
    "--credential-alias",
  ]);
  for (let index = 2; index < process.argv.length; index += 1) {
    if (valueFlags.has(process.argv[index])) {
      index += 1;
      continue;
    }
    if (!process.argv[index].startsWith("--")) return process.argv[index];
  }
  return undefined;
}

async function authToken(): Promise<string> {
  const explicit =
    process.env.PIM_SERVICE_TOKEN?.trim() ||
    process.env.PIM_ACCESS_TOKEN?.trim();
  if (explicit) return explicit;
  const credentials = loadCredentials();
  if (!credentials) {
    throw new Error(
      "No PIM auth found; set PIM_SERVICE_TOKEN/PIM_ACCESS_TOKEN or run `pim login`",
    );
  }
  return (await ensureFreshToken(credentials)).access_token;
}

async function main(): Promise<void> {
  const bundlePath = path.resolve(
    positional() ??
      ".data/exports/mimir-main.skill-catalog.json",
  );
  const baseUrl = (
    arg("--base-url") ??
    process.env.PIM_BASE_URL ??
    process.env.COUNCIL_API_URL ??
    "https://d1ygncl0yqo6sv.cloudfront.net"
  ).replace(/\/+$/, "");
  const org =
    arg("--org") ??
    process.env.PIM_ORG_SLUG ??
    process.env.PIM_ORG;
  const body = fs.readFileSync(bundlePath, "utf8");
  const parsed = JSON.parse(body) as {
    source?: {
      sourceId?: unknown;
      displayName?: unknown;
      apiBaseUrl?: unknown;
      owner?: unknown;
      repo?: unknown;
      defaultRef?: unknown;
      layoutRules?: unknown;
      excludeGlobs?: unknown;
    };
  };
  const sourceId = parsed.source?.sourceId;
  if (typeof sourceId !== "string" || !sourceId) {
    throw new Error("Bundle does not contain a source.sourceId");
  }

  const token = await authToken();
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });
  if (org) headers.set("X-Pim-Org", org);

  if (process.argv.includes("--create-source")) {
    const statusResponse = await fetch(
      `${baseUrl}/api/skill-catalog/sources/${encodeURIComponent(sourceId)}`,
      { headers },
    );
    if (statusResponse.status === 404) {
      const sourceResponse = await fetch(
        `${baseUrl}/api/skill-catalog/sources`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            sourceId,
            displayName: parsed.source?.displayName,
            apiBaseUrl: parsed.source?.apiBaseUrl,
            owner: parsed.source?.owner,
            repo: parsed.source?.repo,
            defaultRef: parsed.source?.defaultRef,
            layoutRules: parsed.source?.layoutRules,
            excludeGlobs: parsed.source?.excludeGlobs,
            credentialAlias:
              arg("--credential-alias") ??
              "OFFLINE_SKILL_CATALOG_TOKEN",
            enabled: false,
          }),
        },
      );
      const sourceBody = await sourceResponse.text();
      if (!sourceResponse.ok) {
        throw new Error(
          `PIM source creation failed (${sourceResponse.status})${
            sourceBody ? `: ${sourceBody.slice(0, 1_000)}` : ""
          }`,
        );
      }
      process.stdout.write(
        `[skill-catalog-upload] Created disabled offline source ${sourceId}\n`,
      );
    } else if (!statusResponse.ok) {
      const statusBody = await statusResponse.text();
      throw new Error(
        `PIM source lookup failed (${statusResponse.status})${
          statusBody ? `: ${statusBody.slice(0, 1_000)}` : ""
        }`,
      );
    }
  }

  const response = await fetch(
    `${baseUrl}/api/skill-catalog/sources/${encodeURIComponent(sourceId)}/import`,
    {
      method: "POST",
      headers,
      body,
    },
  );
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `PIM import failed (${response.status})${
        responseBody ? `: ${responseBody.slice(0, 1_000)}` : ""
      }`,
    );
  }
  const result = JSON.parse(responseBody) as {
    catalog?: {
      commitSha?: string;
      snapshotState?: string;
    };
    imported?: {
      entries?: number;
      blobs?: number;
      embeddingDimensions?: number | null;
    };
  };
  process.stdout.write(
    [
      "[skill-catalog-upload] Import complete",
      `  source:      ${sourceId}`,
      `  commit:      ${result.catalog?.commitSha ?? "unknown"}`,
      `  state:       ${result.catalog?.snapshotState ?? "unknown"}`,
      `  entries:     ${result.imported?.entries ?? "unknown"}`,
      `  blobs:       ${result.imported?.blobs ?? "unknown"}`,
      `  dimensions:  ${result.imported?.embeddingDimensions ?? "none"}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(
    `[skill-catalog-upload] Failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
