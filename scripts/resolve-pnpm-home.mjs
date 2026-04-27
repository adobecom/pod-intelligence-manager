import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * PNPM_HOME is normally set by `pnpm setup` in the shell profile. Corepack /
 * npm-installed pnpm often runs without it, which breaks `pnpm link --global`
 * (ERR_PNPM_NO_GLOBAL_BIN_DIR) even though `pnpm root -g` still resolves.
 */
export function resolvePnpmHome() {
  const fromEnv = process.env.PNPM_HOME?.trim();
  if (fromEnv) return fromEnv;

  try {
    const rootG = execSync("pnpm root -g", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const m = rootG.match(/^(.*)[/\\]global[/\\][^/\\]+[/\\]node_modules$/);
    if (m) return m[1];
  } catch {
    // fall through to platform defaults
  }

  const h = homedir();
  if (process.platform === "darwin") return join(h, "Library", "pnpm");
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, "pnpm");
    return join(h, "AppData", "Local", "pnpm");
  }
  return join(h, ".local", "share", "pnpm");
}
