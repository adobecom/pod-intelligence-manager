/**
 * Claude Code PreToolUse hook handler.
 *
 * Checks if pod context has been pulled recently. If stale (>2 hours or missing),
 * writes a warning to stderr. Does NOT block execution.
 *
 * This creates a soft enforcement layer on top of the CLAUDE.md mandate
 * to always pull context before starting work.
 */
import fs from "node:fs";
import path from "node:path";
import { findGitRoot } from "../config.js";

const STALENESS_MS = 2 * 60 * 60 * 1000; // 2 hours

function main(): void {
  const root = findGitRoot();
  if (!root) return; // Not in a git repo — nothing to check

  const lastPullPath = path.join(root, ".pim", "last-pull");

  if (!fs.existsSync(lastPullPath)) {
    console.error(
      "[pim] Pod context has not been pulled this session. Run: pim context (or /sync) before proceeding.",
    );
    return;
  }

  try {
    const lastPull = fs.readFileSync(lastPullPath, "utf-8").trim();
    const lastPullTime = new Date(lastPull).getTime();

    if (isNaN(lastPullTime)) {
      console.error("[pim] Invalid last-pull timestamp. Run: pim context to refresh.");
      return;
    }

    const ageMs = Date.now() - lastPullTime;
    if (ageMs > STALENESS_MS) {
      const hours = Math.floor(ageMs / (60 * 60 * 1000));
      const mins = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
      console.error(
        `[pim] Pod context is stale (${hours}h ${mins}m old). Run: pim context --diff to see what changed.`,
      );
    }
  } catch {
    // Can't read the file — warn once
    console.error("[pim] Could not check context freshness. Run: pim context to refresh.");
  }
}

main();
