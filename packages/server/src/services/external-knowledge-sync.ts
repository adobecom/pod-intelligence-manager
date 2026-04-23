import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextSearchHit, EnhancedPodLearning } from "@pim/shared";
import { callLLM, isLLMAvailable, MODELS } from "../pim/llm.js";
import { addLearningsToGraph } from "./knowledge-graph.js";
import { loadSyncWatermarks, saveSyncWatermarks } from "./graph-storage.js";
import { searchContext } from "./context-search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BATCH_SIZE = 10;
const MAX_HITS = parseInt(process.env.EXTERNAL_SYNC_MAX_HITS ?? "60", 10);
const MAX_HITS_PER_QUERY = 10;

// Seed queries targeting high-signal org activity across all configured sources
const SEED_QUERIES = [
  "architecture decision",
  "won't fix wontfix deprecated",
  "revert rollback",
  "rfc proposal",
  "resolved blocked",
  "breaking change migration",
  "security vulnerability",
  "pattern best practice",
];

export interface SyncResult {
  items_fetched: number;
  items_processed: number;
  learnings_added: number;
  sources_used: string[];
  duration_ms: number;
}

// --- System prompt (lazy-loaded) ---

let _systemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (!_systemPrompt) {
    _systemPrompt = fs.readFileSync(
      path.resolve(__dirname, "../../../../prompts/external-knowledge-extraction-agent.md"),
      "utf-8",
    );
  }
  return _systemPrompt;
}

// --- Fetch via context search ---

async function fetchHighSignalHits(timeWindowDays: number): Promise<{ hits: ContextSearchHit[]; sources: string[] }> {
  const seen = new Set<string>();
  const hits: ContextSearchHit[] = [];
  const sourcesUsed = new Set<string>();

  for (const query of SEED_QUERIES) {
    if (hits.length >= MAX_HITS) break;
    try {
      const result = await searchContext({
        query,
        time_window_days: timeWindowDays,
        max_hits_per_source: MAX_HITS_PER_QUERY,
        synthesize: false,
        use_cache: false,
      });

      for (const source of result.sources_used) sourcesUsed.add(source);

      for (const hit of result.hits) {
        const key = hit.url ?? `${hit.source}:${hit.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(hit);
        if (hits.length >= MAX_HITS) break;
      }
    } catch {
      // Non-fatal — skip this query
    }
  }

  return { hits, sources: [...sourcesUsed] };
}

// --- LLM extraction ---

interface RawLearning {
  type?: string;
  domain?: string[];
  summary?: string;
  details?: string;
  confidence?: string;
}

const VALID_TYPES = new Set(["decision", "pattern", "anti_pattern", "resolved_conflict", "scope_insight"]);

function mapConfidenceScore(c: string): number {
  if (c === "high") return 0.85;
  if (c === "medium") return 0.6;
  return 0.4;
}

async function extractLearningsFromHits(hits: ContextSearchHit[]): Promise<EnhancedPodLearning[]> {
  if (!isLLMAvailable() || hits.length === 0) return [];

  const systemPrompt = getSystemPrompt();
  const learnings: EnhancedPodLearning[] = [];

  for (let i = 0; i < hits.length; i += BATCH_SIZE) {
    const batch = hits.slice(i, i + BATCH_SIZE);
    try {
      const raw = await callLLM({
        model: MODELS.smart,
        system: systemPrompt,
        prompt: JSON.stringify(batch, null, 2),
        maxTokens: 2048,
      });

      const jsonMatch =
        raw.match(/```(?:json)?\s*([\s\S]*?)```/) ??
        raw.match(/([\[{][\s\S]*[\]}])/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[1]) as RawLearning[];
      if (!Array.isArray(parsed)) continue;

      for (const item of parsed) {
        if (!item.type || !VALID_TYPES.has(item.type)) continue;
        if (!item.summary?.trim() || !item.details?.trim()) continue;
        learnings.push({
          type: item.type as EnhancedPodLearning["type"],
          summary: item.summary.trim(),
          details: item.details.trim(),
          domains: Array.isArray(item.domain) && item.domain.length > 0 ? item.domain : ["general"],
          confidence: "inferred",
          confidence_score: mapConfidenceScore(item.confidence ?? "medium"),
        });
      }
    } catch {
      // Non-fatal — skip this batch
    }
  }

  return learnings;
}

// --- Main entry point ---

export async function syncExternalKnowledge(orgId: string): Promise<SyncResult> {
  const start = Date.now();
  const watermarks = loadSyncWatermarks(orgId);

  const lastSyncedAt = watermarks.last_synced_at ? new Date(watermarks.last_synced_at) : null;
  const daysSinceSync = lastSyncedAt
    ? Math.ceil((Date.now() - lastSyncedAt.getTime()) / 86_400_000)
    : 90;
  const timeWindowDays = Math.min(Math.max(daysSinceSync, 1), 90);

  const { hits, sources } = await fetchHighSignalHits(timeWindowDays);

  let learningsAdded = 0;
  if (hits.length > 0) {
    const learnings = await extractLearningsFromHits(hits);
    if (learnings.length > 0) {
      const r = await addLearningsToGraph(learnings, "external-sync", "External Sync");
      learningsAdded = r.nodesAdded;
    }
  }

  saveSyncWatermarks(orgId, { last_synced_at: new Date().toISOString() });

  return {
    items_fetched: hits.length,
    items_processed: hits.length,
    learnings_added: learningsAdded,
    sources_used: sources,
    duration_ms: Date.now() - start,
  };
}
