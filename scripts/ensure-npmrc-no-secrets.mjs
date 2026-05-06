#!/usr/bin/env node
/**
 * Fails CI if the repo-root .npmrc contains auth material.
 * Tokens belong in ~/.npmrc (see docs/NPM_ARTIFACTORY.md).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmrc = path.join(root, ".npmrc");
if (!fs.existsSync(npmrc)) process.exit(0);

const s = fs.readFileSync(npmrc, "utf8");
const bad =
  /_authToken\s*=/i.test(s) ||
  /_password\s*=/i.test(s) ||
  /NPM_TOKEN\s*=/i.test(s);

if (bad) {
  console.error(
    "Repo .npmrc must not contain credentials. Remove _authToken / NPM_TOKEN= lines.\n" +
      "Use your user ~/.npmrc or npm login --auth-type=web (see docs/NPM_ARTIFACTORY.md).",
  );
  process.exit(1);
}
