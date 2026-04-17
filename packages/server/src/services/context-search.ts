import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ContextSearchHit,
  ContextSearchRequest,
  ContextSearchResult,
  ContextSource,
} from "@council/shared";
import { CONTEXT_SOURCES } from "@council/shared";
import { callLLM, isLLMAvailable, MODELS } from "../council/llm.js";
import { redactSecrets } from "./secret-scan.js";
import { searchSlack } from "../integrations/slack.js";
import { searchFluffyjaws } from "../integrations/fluffyjaws.js";
import { searchJira } from "../integrations/jira.js";
import { searchConfluence } from "../integrations/confluence.js";
import { searchGithub } from "../integrations/github.js";
import { searchGit } from "../integrations/git.js";
import type { IntegrationResult, IntegrationSearchOpts } from "../integrations/types.js";

const DEFAULT_TIME_WINDOW_DAYS = 90;
const DEFAULT_MAX_HITS_PER_SOURCE = 10;
const DEFAULT_CACHE_TTL_SEC = 3600;
const CACHE_DIR = path.resolve(process.cwd(), ".data", "context-search-cache");
const PROMPT_PATH = path.resolve(
  new URL(".", import.meta.url).pathname,
  "../../../../prompts/context-search-synthesis.md",
);

type Integration = (opts: IntegrationSearchOpts) => Promise<IntegrationResult>;

const INTEGRATIONS: Record<ContextSource, Integration> = {
  slack: searchSlack,
  fluffyjaws: searchFluffyjaws,
  jira: searchJira,
  confluence: searchConfluence,
  github: searchGithub,
  git: searchGit,
};

function cacheKey(req: ContextSearchRequest): string {
  const normalized = {
    query: req.query.trim().toLowerCase(),
    sources: [...(req.sources ?? CONTEXT_SOURCES)].sort(),
    time_window_days: req.time_window_days ?? DEFAULT_TIME_WINDOW_DAYS,
    max_hits_per_source: req.max_hits_per_source ?? DEFAULT_MAX_HITS_PER_SOURCE,
    synthesize: req.synthesize !== false,
    pod_id: req.pod_id ?? null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

function readCache(key: string, ttlSec: number): ContextSearchResult | null {
  try {
    const p = cachePath(key);
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    const ageSec = (Date.now() - stat.mtimeMs) / 1000;
    if (ageSec > ttlSec) return null;
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as ContextSearchResult;
  } catch {
    return null;
  }
}

function writeCache(key: string, result: ContextSearchResult): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify(result), "utf-8");
  } catch (err) {
    console.error("[context-search] cache write failed:", (err as Error).message);
  }
}

function sourceAuthority(source: ContextSource): number {
  // Higher is better. Used as a ranking bonus.
  return { jira: 4, confluence: 4, github: 3, git: 3, slack: 2, fluffyjaws: 1 }[source];
}

function rankHits(hits: ContextSearchHit[], query: string): ContextSearchHit[] {
  const now = Date.now();
  const q = query.toLowerCase();
  const phrases = q.split(/\s+/).filter(Boolean);

  return [...hits].sort((a, b) => score(b) - score(a));

  function score(h: ContextSearchHit): number {
    const authority = sourceAuthority(h.source);
    const text = `${h.title} ${h.snippet}`.toLowerCase();
    const exact = text.includes(q) ? 3 : 0;
    const phraseHits = phrases.filter((p) => text.includes(p)).length;
    const recency = h.timestamp
      ? Math.max(0, 2 - (now - new Date(h.timestamp).getTime()) / (30 * 24 * 3600 * 1000))
      : 0;
    return authority + exact + phraseHits * 0.5 + recency;
  }
}

function dedupe(hits: ContextSearchHit[]): ContextSearchHit[] {
  const seen = new Map<string, ContextSearchHit>();
  for (const h of hits) {
    const key = (h.url ?? "") + "|" + h.title.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, h);
  }
  return [...seen.values()];
}

function scrubHits(hits: ContextSearchHit[]): ContextSearchHit[] {
  return hits.map((h) => ({
    ...h,
    title: redactSecrets(h.title).text,
    snippet: redactSecrets(h.snippet).text,
  }));
}

let cachedPrompt: string | null = null;
function loadPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  try {
    cachedPrompt = fs.readFileSync(PROMPT_PATH, "utf-8");
  } catch {
    cachedPrompt = "Synthesize the following search hits into a concise, citable markdown summary.";
  }
  return cachedPrompt;
}

async function synthesize(query: string, hits: ContextSearchHit[]): Promise<string | undefined> {
  if (hits.length === 0) return undefined;
  if (!isLLMAvailable()) return undefined;
  try {
    const system = loadPrompt();
    const prompt = JSON.stringify({ query, hits }, null, 2);
    const md = await callLLM({ model: MODELS.fast, system, prompt, maxTokens: 1500 });
    return redactSecrets(md).text;
  } catch (err) {
    console.error("[context-search] synthesis failed:", (err as Error).message);
    return undefined;
  }
}

export async function searchContext(req: ContextSearchRequest): Promise<ContextSearchResult> {
  const ttlSec = parseInt(process.env.CONTEXT_SEARCH_CACHE_TTL_SEC ?? String(DEFAULT_CACHE_TTL_SEC), 10);
  const useCache = req.use_cache !== false;

  const key = cacheKey(req);
  if (useCache) {
    const cached = readCache(key, ttlSec);
    if (cached) return { ...cached, from_cache: true };
  }

  const integrationOpts: IntegrationSearchOpts = {
    query: req.query,
    time_window_days: req.time_window_days ?? DEFAULT_TIME_WINDOW_DAYS,
    max_hits_per_source: req.max_hits_per_source ?? DEFAULT_MAX_HITS_PER_SOURCE,
    pod_id: req.pod_id,
  };

  const selected = (req.sources ?? CONTEXT_SOURCES).filter((s) => s in INTEGRATIONS);
  const settled = await Promise.allSettled(selected.map((s) => INTEGRATIONS[s](integrationOpts)));

  const missing_sources: ContextSearchResult["missing_sources"] = [];
  const allHits: ContextSearchHit[] = [];
  const sources_used: ContextSource[] = [];

  settled.forEach((r, i) => {
    const source = selected[i];
    if (r.status === "rejected") {
      missing_sources.push({ source, reason: String(r.reason?.message ?? r.reason) });
      return;
    }
    const res = r.value;
    if (res.missing) missing_sources.push({ source, reason: res.missing });
    if (res.hits.length > 0) {
      sources_used.push(source);
      allHits.push(...res.hits);
    }
  });

  const ranked = rankHits(dedupe(scrubHits(allHits)), req.query);

  const summary_md =
    req.synthesize !== false ? await synthesize(req.query, ranked) : undefined;

  const result: ContextSearchResult = {
    query: req.query,
    summary_md,
    hits: ranked,
    sources_used,
    missing_sources,
    from_cache: false,
    generated_at: new Date().toISOString(),
  };

  if (useCache) {
    writeCache(key, { ...result, cached_at: result.generated_at });
  }

  return result;
}
