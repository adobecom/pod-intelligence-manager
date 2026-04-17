import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

// This file is packages/server/src/load-env.ts → monorepo root is three levels up.
const here = dirname(fileURLToPath(import.meta.url));
const repoRootEnv = resolve(here, "../../../.env");
const serverLocalEnv = resolve(here, "../.env");

if (existsSync(repoRootEnv)) {
  config({ path: repoRootEnv });
}
if (existsSync(serverLocalEnv)) {
  config({ path: serverLocalEnv, override: true });
}
