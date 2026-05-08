import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader. Reads `<repo-root>/.env` (three dirs up from this file
 * once compiled / two from src) and `packages/eval/.env`, populating
 * `process.env` only for keys that aren't already set. Mirrors the pattern
 * in `packages/server/src/load-env.ts` without pulling dotenv into this
 * lightweight package.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRootEnv = resolve(here, "..", "..", "..", ".env");
const localEnv = resolve(here, "..", ".env");

if (existsSync(repoRootEnv)) loadFile(repoRootEnv, false);
if (existsSync(localEnv)) loadFile(localEnv, true);

function loadFile(path: string, override: boolean): void {
  try {
    const raw = readFileSync(path, "utf8");
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (override || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore — env vars from the shell take precedence anyway
  }
}
