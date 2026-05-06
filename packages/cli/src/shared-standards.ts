import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { STANDARDS_CATALOGUE, type StandardsSource } from "./standards-catalogue.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface StandardsLockSource {
  id: string;
  repo: string;
  branch: string;
  path: string;
  installedSha: string;
  installedItems: string[];
}

export interface StandardsLock {
  version: number;
  updatedAt: string;
  lastChecked: string;
  sources: StandardsLockSource[];
}

export function readStandardsLock(root: string): StandardsLock | null {
  const lockPath = path.join(root, ".pim", "standards.lock.json");
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf-8")) as StandardsLock;
  } catch {
    return null;
  }
}

export function writeStandardsLock(root: string, lock: StandardsLock): void {
  const lockPath = path.join(root, ".pim", "standards.lock.json");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

export async function fetchLatestCommitSha(source: StandardsSource): Promise<string> {
  const url = `${GITHUB_API}/repos/${source.repo}/commits?path=${source.path}&sha=${source.branch}&per_page=1`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "pim-cli" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${source.repo}`);
  const commits = (await res.json()) as Array<{ sha: string }>;
  if (!commits.length) throw new Error(`No commits found for ${source.repo}/${source.path}`);
  return commits[0].sha;
}

export async function fetchItemListing(source: StandardsSource): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${source.repo}/contents/${source.path}?ref=${source.branch}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "pim-cli" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} listing ${source.repo}/${source.path}`);
  const items = (await res.json()) as Array<{ name: string; type: string }>;
  return items.filter(i => i.type === "dir").map(i => i.name);
}

async function downloadItem(source: StandardsSource, itemName: string, destDir: string): Promise<void> {
  const dest = path.join(destDir, itemName);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of source.files) {
    const rawUrl = `${GITHUB_RAW}/${source.repo}/${source.branch}/${source.path}/${itemName}/${file}`;
    const res = await fetch(rawUrl, {
      headers: { "User-Agent": "pim-cli" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      if (res.status === 404) continue;
      throw new Error(`Failed to fetch ${rawUrl}: HTTP ${res.status}`);
    }
    fs.writeFileSync(path.join(dest, file), await res.text(), "utf-8");
  }
}

export interface InstallResult {
  sourceId: string;
  installedItems: string[];
  sha: string;
}

export async function installSourceStandards(
  root: string,
  source: StandardsSource,
  onProgress?: (msg: string) => void,
): Promise<InstallResult> {
  const destDir = path.join(root, ".claude", "skills");
  const [items, sha] = await Promise.all([
    fetchItemListing(source),
    fetchLatestCommitSha(source),
  ]);
  const installedItems: string[] = [];
  for (const item of items) {
    await downloadItem(source, item, destDir);
    installedItems.push(item);
    onProgress?.(`    ${chalk.green("✓")} ${item}`);
  }
  return { sourceId: source.id, installedItems, sha };
}

export async function installSelectedSources(root: string, selectedSourceIds: string[]): Promise<void> {
  const now = new Date().toISOString();
  const lock = readStandardsLock(root) ?? { version: 1, updatedAt: now, lastChecked: now, sources: [] };

  for (const sourceId of selectedSourceIds) {
    const source = STANDARDS_CATALOGUE.find(s => s.id === sourceId);
    if (!source) continue;
    console.log(chalk.dim(`  Installing ${source.name}...`));
    try {
      const result = await installSourceStandards(root, source, msg => console.log(msg));
      const entry: StandardsLockSource = {
        id: sourceId,
        repo: source.repo,
        branch: source.branch,
        path: source.path,
        installedSha: result.sha,
        installedItems: result.installedItems,
      };
      const idx = lock.sources.findIndex(s => s.id === sourceId);
      if (idx >= 0) {
        lock.sources[idx] = entry;
      } else {
        lock.sources.push(entry);
      }
      console.log(chalk.green(`  Installed ${result.installedItems.length} items from ${source.name}`));
    } catch (e) {
      console.log(chalk.yellow(`  Could not install ${source.name}: ${e instanceof Error ? e.message : e}`));
    }
  }

  if (lock.sources.length > 0) {
    lock.updatedAt = now;
    lock.lastChecked = now;
    writeStandardsLock(root, lock);
    console.log(chalk.green("  Updated .pim/standards.lock.json"));
  }
}

export async function checkForUpdates(
  root: string,
): Promise<{ upToDate: boolean; staleSources: string[] }> {
  const lock = readStandardsLock(root);
  if (!lock?.sources.length) return { upToDate: true, staleSources: [] };
  const now = Date.now();
  const lastChecked = new Date(lock.lastChecked).getTime();
  if (now - lastChecked < STALE_THRESHOLD_MS) return { upToDate: true, staleSources: [] };
  const staleSources: string[] = [];
  for (const lockedSource of lock.sources) {
    const source = STANDARDS_CATALOGUE.find(s => s.id === lockedSource.id);
    if (!source) continue;
    try {
      const latestSha = await fetchLatestCommitSha(source);
      if (latestSha !== lockedSource.installedSha) staleSources.push(lockedSource.id);
    } catch {
      // Network error — skip, don't block init
    }
  }
  lock.lastChecked = new Date().toISOString();
  writeStandardsLock(root, lock);
  return { upToDate: staleSources.length === 0, staleSources };
}

export async function buildWizardStandardsChoices(): Promise<
  Array<{ name: string; value: string; checked: boolean }>
> {
  return Promise.all(
    STANDARDS_CATALOGUE.map(async (source) => {
      let detail = source.description;
      try {
        const items = await fetchItemListing(source);
        detail = items.join(", ");
      } catch {
        // Use catalogue description as fallback
      }
      return { name: `${source.name} — ${detail}`, value: source.id, checked: true };
    }),
  );
}
