import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { STANDARDS_CATALOGUE, type StandardsSource } from "./standards-catalogue.js";
export type { StandardsSource };

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
  /** Stored for virtual sources (discovered via marketplace.json) so that
   *  update-standards can reconstruct the source without a catalogue lookup. */
  files?: string[];
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
  itemFilter?: string[],
): Promise<InstallResult> {
  const destDir = path.join(root, ".claude", "skills");
  const [items, sha] = await Promise.all([
    fetchItemListing(source),
    fetchLatestCommitSha(source),
  ]);
  const toInstall = itemFilter?.length ? items.filter(i => itemFilter.includes(i)) : items;
  if (itemFilter?.length && toInstall.length === 0) {
    console.log(chalk.yellow(`  Warning: none of the requested items for ${source.name} were found in the repo. The catalogue may be stale.`));
  }
  const installedItems: string[] = [];
  for (const item of toInstall) {
    await downloadItem(source, item, destDir);
    installedItems.push(item);
    onProgress?.(`    ${chalk.green("✓")} ${item}`);
  }
  return { sourceId: source.id, installedItems, sha };
}

/**
 * Decodes encoded wizard checkbox values into per-source install instructions.
 * Value format: "sourceId:itemName" (per-item) or "sourceId" (install all, offline fallback).
 */
export function parseStandardsSelections(
  values: string[],
): { sourceId: string; items: string[] }[] {
  const map = new Map<string, string[]>();
  for (const v of values) {
    const colon = v.indexOf(":");
    if (colon === -1) {
      if (!map.has(v)) map.set(v, []);
    } else {
      const sourceId = v.slice(0, colon);
      const item = v.slice(colon + 1);
      if (!map.has(sourceId)) map.set(sourceId, []);
      map.get(sourceId)!.push(item);
    }
  }
  return Array.from(map.entries()).map(([sourceId, items]) => ({ sourceId, items }));
}

export async function installSelectedSources(
  root: string,
  encodedValues: string[],
  virtualSources: StandardsSource[] = [],
): Promise<void> {
  const allSources = [...STANDARDS_CATALOGUE, ...virtualSources];
  const now = new Date().toISOString();
  const lock = readStandardsLock(root) ?? { version: 1, updatedAt: now, lastChecked: now, sources: [] };
  const selections = parseStandardsSelections(encodedValues);

  for (const { sourceId, items } of selections) {
    const source = allSources.find(s => s.id === sourceId);
    if (!source) continue;
    console.log(chalk.dim(`  Installing ${source.name}...`));
    try {
      const result = await installSourceStandards(root, source, msg => console.log(msg), items.length ? items : undefined);
      const isVirtual = !STANDARDS_CATALOGUE.find(s => s.id === sourceId);
      const entry: StandardsLockSource = {
        id: sourceId,
        repo: source.repo,
        branch: source.branch,
        path: source.path,
        installedSha: result.sha,
        installedItems: result.installedItems,
        ...(isVirtual ? { files: source.files } : {}),
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

/** Data fetched per catalogue source for the init wizard. */
export interface WizardSourceData {
  source: StandardsSource;
  /** Directory names from GitHub. Empty if the listing fetch failed. */
  items: string[];
  /** True if the GitHub listing call failed; wizard shows a single source-level entry. */
  fallback: boolean;
}

interface MarketplacePlugin {
  name: string;
  source: string; // e.g. "./plugins/adobe-analytics"
  description?: string;
}

function prettifyName(slug: string): string {
  const acronyms = new Set(["aem", "lts", "eds", "api", "ai"]);
  return slug
    .split("-")
    .map(word => (acronyms.has(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

async function fetchMarketplacePlugins(source: StandardsSource): Promise<MarketplacePlugin[]> {
  const url = `${GITHUB_RAW}/${source.repo}/${source.branch}/${source.marketplacePath}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "pim-cli" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub raw ${res.status} for ${source.repo}/${source.marketplacePath}`);
  const data = (await res.json()) as { plugins?: MarketplacePlugin[] };
  return data.plugins ?? [];
}

function buildVirtualSource(parent: StandardsSource, plugin: MarketplacePlugin): StandardsSource {
  const pluginPath = plugin.source.replace(/^\.\//, "");
  return {
    id: `${parent.id}:${plugin.name}`,
    name: prettifyName(plugin.name),
    description: plugin.description ?? "",
    repo: parent.repo,
    branch: parent.branch,
    path: `${pluginPath}/skills`,
    files: parent.files,
  };
}

/**
 * Fetches item listings for all catalogue sources in parallel.
 * Marketplace-driven sources (marketplacePath set) are expanded into one
 * WizardSourceData per plugin. Never throws.
 */
export async function fetchStandardsForWizard(): Promise<{
  wizardData: WizardSourceData[];
  virtualSources: StandardsSource[];
}> {
  const virtualSources: StandardsSource[] = [];

  const groups = await Promise.all(
    STANDARDS_CATALOGUE.map(async (source): Promise<WizardSourceData[]> => {
      if (source.marketplacePath) {
        let plugins: MarketplacePlugin[];
        try {
          plugins = await fetchMarketplacePlugins(source);
        } catch {
          return [{ source, items: source.staticItems ?? [], fallback: true }];
        }

        const results = await Promise.allSettled(
          plugins.map(async (plugin): Promise<WizardSourceData | null> => {
            const virtual = buildVirtualSource(source, plugin);
            try {
              const items = await fetchItemListing(virtual);
              virtualSources.push(virtual);
              return { source: virtual, items, fallback: false };
            } catch {
              return null;
            }
          }),
        );

        return results.flatMap(r => (r.status === "fulfilled" && r.value ? [r.value] : []));
      }

      try {
        const items = await fetchItemListing(source);
        return [{ source, items, fallback: false }];
      } catch {
        return [{ source, items: source.staticItems ?? [], fallback: true }];
      }
    }),
  );

  return { wizardData: groups.flat(), virtualSources };
}
