import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { SKILL_CATALOGUE, type SkillSource } from "./skill-catalogue.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface SkillsLockSource {
  id: string;
  repo: string;
  branch: string;
  path: string;
  installedSha: string;
  installedSkills: string[];
}

export interface SkillsLock {
  version: number;
  updatedAt: string;
  lastChecked: string;
  sources: SkillsLockSource[];
}

export function readSkillsLock(root: string): SkillsLock | null {
  const lockPath = path.join(root, ".pim", "skills.lock.json");
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf-8")) as SkillsLock;
  } catch {
    return null;
  }
}

export function writeSkillsLock(root: string, lock: SkillsLock): void {
  const lockPath = path.join(root, ".pim", "skills.lock.json");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

export async function fetchLatestCommitSha(source: SkillSource): Promise<string> {
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

export async function fetchSkillListing(source: SkillSource): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${source.repo}/contents/${source.path}?ref=${source.branch}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "pim-cli" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} listing ${source.repo}/${source.path}`);
  const items = (await res.json()) as Array<{ name: string; type: string }>;
  return items.filter(i => i.type === "dir").map(i => i.name);
}

async function downloadSkill(source: SkillSource, skillName: string, skillsDir: string): Promise<void> {
  const dest = path.join(skillsDir, skillName);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of source.skillFiles) {
    const rawUrl = `${GITHUB_RAW}/${source.repo}/${source.branch}/${source.path}/${skillName}/${file}`;
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
  installedSkills: string[];
  sha: string;
}

export async function installSourceSkills(
  root: string,
  source: SkillSource,
  onProgress?: (msg: string) => void,
): Promise<InstallResult> {
  const skillsDir = path.join(root, ".claude", "skills");
  const [skills, sha] = await Promise.all([
    fetchSkillListing(source),
    fetchLatestCommitSha(source),
  ]);
  const installedSkills: string[] = [];
  for (const skill of skills) {
    await downloadSkill(source, skill, skillsDir);
    installedSkills.push(skill);
    onProgress?.(`    ${chalk.green("✓")} ${skill}`);
  }
  return { sourceId: source.id, installedSkills, sha };
}

export async function installSelectedSources(root: string, selectedSourceIds: string[]): Promise<void> {
  const now = new Date().toISOString();
  const lock = readSkillsLock(root) ?? { version: 1, updatedAt: now, lastChecked: now, sources: [] };

  for (const sourceId of selectedSourceIds) {
    const source = SKILL_CATALOGUE.find(s => s.id === sourceId);
    if (!source) continue;
    console.log(chalk.dim(`  Installing ${source.name}...`));
    try {
      const result = await installSourceSkills(root, source, msg => console.log(msg));
      const entry: SkillsLockSource = {
        id: sourceId,
        repo: source.repo,
        branch: source.branch,
        path: source.path,
        installedSha: result.sha,
        installedSkills: result.installedSkills,
      };
      const idx = lock.sources.findIndex(s => s.id === sourceId);
      if (idx >= 0) {
        lock.sources[idx] = entry;
      } else {
        lock.sources.push(entry);
      }
      console.log(chalk.green(`  Installed ${result.installedSkills.length} skills from ${source.name}`));
    } catch (e) {
      console.log(chalk.yellow(`  Could not install ${source.name}: ${e instanceof Error ? e.message : e}`));
    }
  }

  if (lock.sources.length > 0) {
    lock.updatedAt = now;
    lock.lastChecked = now;
    writeSkillsLock(root, lock);
    console.log(chalk.green("  Updated .pim/skills.lock.json"));
  }
}

export async function checkForUpdates(
  root: string,
): Promise<{ upToDate: boolean; staleSources: string[] }> {
  const lock = readSkillsLock(root);
  if (!lock?.sources.length) return { upToDate: true, staleSources: [] };
  const now = Date.now();
  const lastChecked = new Date(lock.lastChecked).getTime();
  if (now - lastChecked < STALE_THRESHOLD_MS) return { upToDate: true, staleSources: [] };
  const staleSources: string[] = [];
  for (const lockedSource of lock.sources) {
    const source = SKILL_CATALOGUE.find(s => s.id === lockedSource.id);
    if (!source) continue;
    try {
      const latestSha = await fetchLatestCommitSha(source);
      if (latestSha !== lockedSource.installedSha) staleSources.push(lockedSource.id);
    } catch {
      // Network error — skip, don't block init
    }
  }
  lock.lastChecked = new Date().toISOString();
  writeSkillsLock(root, lock);
  return { upToDate: staleSources.length === 0, staleSources };
}

export async function buildWizardSkillChoices(): Promise<
  Array<{ name: string; value: string; checked: boolean }>
> {
  return Promise.all(
    SKILL_CATALOGUE.map(async (source) => {
      let detail = source.description;
      try {
        const skills = await fetchSkillListing(source);
        detail = skills.join(", ");
      } catch {
        // Use catalogue description as fallback
      }
      return { name: `${source.name} — ${detail}`, value: source.id, checked: true };
    }),
  );
}
