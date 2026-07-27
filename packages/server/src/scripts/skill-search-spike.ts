/**
 * Retrieval feasibility spike for SKILL_CONFLICT_DETECTION_PLAN_V2 §9.
 *
 * Throwaway experiment answering the load-bearing question before any catalog
 * infrastructure is built: do 1-2 sentence intents retrieve the right existing
 * skill via embedding cosine ranking?
 *
 * Uses the REAL Mimir skill corpus (better than the synthetic fallback) and the
 * existing Titan v2 path in services/embeddings.ts. One vector per skill
 * (name + title + description + headings). Query = the 1-2 sentence intent.
 *
 * Run:
 *   MIMIR_DIR=/path/to/mimir tsx src/scripts/skill-search-spike.ts
 *
 * Embeddings are cached to scratchpad by content hash so re-runs are instant.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { generateEmbedding, cosineSimilarity } from "../services/embeddings.js";

// Load repo-root .env (AWS_BEARER_TOKEN_BEDROCK, AWS_REGION) without overriding
// anything already exported in the shell.
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const MIMIR_DIR = process.env.MIMIR_DIR;
if (!MIMIR_DIR) {
  console.error("Set MIMIR_DIR to a local Mimir checkout.");
  process.exit(1);
}

const CACHE_PATH = process.env.SPIKE_CACHE ?? "/tmp/skill-spike-embed-cache.json";
const EMBED_DELAY_MS = 1100; // ~1 req/s, matches the Bedrock limit in embeddings.ts

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

interface Skill {
  path: string; // repo-relative
  namespace: string; // project:<id> | shared
  name: string; // normalized filename
  title: string; // H1
  description: string; // first real paragraph
  headings: string[];
  embedText: string;
  placeholder: boolean;
}

function normalizeName(file: string): string {
  return file
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[-_ ]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveNamespace(rel: string): string {
  const m = rel.match(/^projects\/([^/]+)\//);
  if (m) return `project:${m[1]}`;
  if (rel.startsWith("shared/")) return "shared";
  return "unknown";
}

function parseSkill(rel: string, text: string): Skill {
  const lines = text.split(/\r?\n/);
  const title = (lines.find((l) => l.startsWith("# ")) ?? "").replace(/^#\s+/, "").trim();
  let description = "";
  for (const l of lines) {
    const s = l.trim();
    if (!s || s.startsWith("#") || s.startsWith(">") || s.startsWith("<!--") || s === "---" || s === "```") continue;
    description = s;
    break;
  }
  const headings = lines
    .filter((l) => /^#{2,3}\s+/.test(l))
    .map((l) => l.replace(/^#{2,3}\s+/, "").trim());
  const name = normalizeName(path.basename(rel));
  const embedText = [name.replace(/-/g, " "), title, description, headings.join(". ")]
    .filter(Boolean)
    .join("\n");
  return {
    path: rel,
    namespace: deriveNamespace(rel),
    name,
    title,
    description,
    headings,
    embedText,
    placeholder: /PLACEHOLDER/.test(text),
  };
}

function loadCorpus(root: string): Skill[] {
  const out: Skill[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md") && full.includes(`${path.sep}skills${path.sep}`)) {
        const rel = path.relative(root, full);
        out.push(parseSkill(rel, fs.readFileSync(full, "utf8")));
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Query set — 20 intents in 3 groups (plan §9). Targets reference real skills.
// Group 1: re-worded duplicate of an existing skill (must land target in top 3).
// Group 2: same domain, genuinely different behavior (must NOT score like a dup).
// Group 3: unrelated (must score low across the board).
// ---------------------------------------------------------------------------

interface Query {
  id: string;
  group: 1 | 2 | 3;
  intent: string;
  target?: string; // repo-relative path of the skill it re-words (group 1 only)
}

const QUERIES: Query[] = [
  // ---- Group 1: re-worded duplicates ------------------------------------
  {
    id: "g1-deeplink-build",
    group: 1,
    target: "projects/doodlebug/skills/workflow/deeplinks.md",
    intent:
      "A skill that assembles a Firefly hub URL by encoding an hData payload so a page's call-to-action opens the correct module, workflow, and config in Firefly.",
  },
  {
    id: "g1-pdp-publish",
    group: 1,
    target: "projects/cops-authoring/skills/workflow/pdp-publish.md",
    intent:
      "Create a skill that promotes a product-detail-page fragment tree from draft or modified state to published, pushing the parent PDP and every referenced fragment live.",
  },
  {
    id: "g1-breadcrumbs",
    group: 1,
    target: "projects/doodlebug/skills/workflow/breadcrumbs.md",
    intent:
      "A skill that produces breadcrumb navigation markup for each Firefly feature page, serving both as a UX aid and as structured data for Google search results.",
  },
  {
    id: "g1-brand-voice",
    group: 1,
    target: "projects/doodlebug/skills/content/brand-voice.md",
    intent:
      "Define the tone, writing style, and grammar conventions all Firefly feature-page copy must follow, overriding conflicting base-template patterns.",
  },
  {
    id: "g1-bulk-import",
    group: 1,
    target: "projects/cops-authoring/skills/odin/bulk-import.md",
    intent:
      "A skill for mass-creating and mass-updating Odin content fragments from CSV or Excel intake spreadsheets.",
  },
  {
    id: "g1-insight",
    group: 1,
    target: "projects/doodlebug/skills/workflow/insight.md",
    intent:
      "Audit the Firefly feature-page inventory to flag duplicate pages, keyword cannibalization, and stale content.",
  },
  {
    id: "g1-seo-qa",
    group: 1,
    target: "shared/skills/seo/qa-checklist.md",
    intent:
      "A pre-publish SEO checklist that runs after every page update and emits a red / yellow / green scorecard.",
  },
  {
    id: "g1-model-bakeoff",
    group: 1,
    target: "projects/doodlebug/skills/workflow/model-bakeoff.md",
    intent:
      "Determine the best image-generation model for each block type of a creative direction through blind pairwise voting.",
  },
  // ---- Group 2: same domain, different behavior -------------------------
  {
    id: "g2-image-upscale",
    group: 2,
    intent:
      "A skill that upscales generated Firefly images to 4K and compresses them for retina display on adobe.com.",
  },
  {
    id: "g2-deeplink-validate",
    group: 2,
    intent:
      "A skill that crawls already-built Firefly deeplink URLs in production and verifies each one resolves to the intended destination.",
  },
  {
    id: "g2-pdp-rollback",
    group: 2,
    intent:
      "A skill that rolls a published PDP back to a previous snapshot when a bad publish ships to production.",
  },
  {
    id: "g2-link-monitor",
    group: 2,
    intent:
      "A skill that monitors published Firefly pages on a schedule for broken links and 404 responses.",
  },
  {
    id: "g2-keyword-gap",
    group: 2,
    intent:
      "A skill that performs competitor keyword-gap analysis using external search-volume data.",
  },
  {
    id: "g2-moodboard",
    group: 2,
    intent:
      "A skill that generates a mood board of reference imagery from a short text brief.",
  },
  // ---- Group 3: unrelated -----------------------------------------------
  { id: "g3-cloudtrail", group: 3, intent: "A skill that parses AWS CloudTrail logs and flags anomalous IAM activity." },
  { id: "g3-pg-types", group: 3, intent: "A skill that converts a Postgres schema into TypeScript type definitions." },
  { id: "g3-calendar", group: 3, intent: "A skill that books conference rooms through the Google Calendar API." },
  { id: "g3-binpack", group: 3, intent: "A skill that computes optimal bin-packing for warehouse shipping boxes." },
  { id: "g3-transcribe", group: 3, intent: "A skill that transcribes podcast audio and generates chapter markers." },
  { id: "g3-terraform", group: 3, intent: "A skill that lints Terraform for security misconfigurations." },
];

// ---------------------------------------------------------------------------
// Embedding with disk cache
// ---------------------------------------------------------------------------

type Cache = Record<string, number[]>;

function loadCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Cache;
  } catch {
    return {};
  }
}

function saveCache(c: Cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(c));
}

const hash = (t: string) => crypto.createHash("sha256").update(`${process.env.EMBEDDING_DIMENSIONS ?? "512"}:${t}`).digest("hex");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function embedCached(text: string, cache: Cache): Promise<number[]> {
  const key = hash(text);
  if (cache[key]) return cache[key];
  const vec = await generateEmbedding(text);
  if (!vec) throw new Error("Embedding returned null — check AWS_BEARER_TOKEN_BEDROCK / AWS_REGION");
  cache[key] = vec;
  await sleep(EMBED_DELAY_MS);
  return vec;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const pct = (n: number) => (n * 100).toFixed(1);
const fmt = (n: number) => n.toFixed(4);

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], median: q(0.5), max: s[s.length - 1], mean: xs.reduce((a, b) => a + b, 0) / xs.length };
}

async function main() {
  const skills = loadCorpus(MIMIR_DIR!);
  console.log(`Loaded ${skills.length} skills from ${MIMIR_DIR}`);
  console.log(`Embedding model: amazon.titan-embed-text-v2:0 @ ${process.env.EMBEDDING_DIMENSIONS ?? 512} dims, region ${process.env.AWS_REGION}\n`);

  const cache = loadCache();
  const cachedBefore = Object.keys(cache).length;

  // Embed corpus
  const skillVecs: number[][] = [];
  for (let i = 0; i < skills.length; i++) {
    skillVecs.push(await embedCached(skills[i].embedText, cache));
    if ((i + 1) % 20 === 0) {
      saveCache(cache);
      console.log(`  embedded ${i + 1}/${skills.length} skills`);
    }
  }
  saveCache(cache);

  const targetSet = new Set(QUERIES.filter((q) => q.target).map((q) => q.target!));
  for (const t of targetSet) {
    if (!skills.some((s) => s.path === t)) throw new Error(`Query target not found in corpus: ${t}`);
  }

  const g1Targets: number[] = [];
  const g1Top: number[] = [];
  const g2Top: number[] = [];
  const g3Top: number[] = [];
  let top1Hits = 0;
  let top3Hits = 0;
  const g1 = QUERIES.filter((q) => q.group === 1);

  console.log("\n=== Per-query results (top 3) ===\n");
  for (const q of QUERIES) {
    const qv = await embedCached(q.intent, cache);
    saveCache(cache);
    const ranked = skills
      .map((s, i) => ({ s, score: cosineSimilarity(qv, skillVecs[i]) }))
      .sort((a, b) => b.score - a.score);

    const top = ranked.slice(0, 3);
    const top1 = ranked[0].score;

    if (q.group === 1 && q.target) {
      const rank = ranked.findIndex((r) => r.s.path === q.target) + 1;
      const tScore = ranked[rank - 1].score;
      g1Targets.push(tScore);
      g1Top.push(top1);
      if (rank === 1) top1Hits++;
      if (rank <= 3) top3Hits++;
      const flag = rank <= 3 ? "OK " : "MISS";
      console.log(`[G1 ${flag}] ${q.id}  target rank #${rank} (score ${fmt(tScore)})`);
      console.log(`         top: ${top.map((t) => `${t.s.name}=${fmt(t.score)}`).join("  ")}`);
    } else {
      if (q.group === 2) g2Top.push(top1);
      else g3Top.push(top1);
      console.log(`[G${q.group}]      ${q.id}  top1 ${fmt(top1)} (${ranked[0].s.name})`);
      console.log(`         top: ${top.map((t) => `${t.s.name}=${fmt(t.score)}`).join("  ")}`);
    }
  }

  const cachedAfter = Object.keys(cache).length;

  // ---- Summary ----
  const g1t = stats(g1Targets);
  const g2s = stats(g2Top);
  const g3s = stats(g3Top);

  console.log("\n=================== SUMMARY ===================\n");
  console.log(`Corpus: ${skills.length} skills | Queries: ${QUERIES.length} (G1=${g1.length}, G2=${g2Top.length}, G3=${g3Top.length})`);
  console.log(`Embeddings computed this run: ${cachedAfter - cachedBefore} (cache: ${cachedBefore} -> ${cachedAfter})\n`);

  console.log("Group 1 (must retrieve target):");
  console.log(`  top-1 hit rate: ${top1Hits}/${g1.length} (${pct(top1Hits / g1.length)}%)`);
  console.log(`  top-3 hit rate: ${top3Hits}/${g1.length} (${pct(top3Hits / g1.length)}%)`);
  console.log(`  target-score  min=${fmt(g1t.min)} median=${fmt(g1t.median)} max=${fmt(g1t.max)}\n`);

  console.log("Group 2 (near-miss, same domain):");
  console.log(`  top-1 score   min=${fmt(g2s.min)} median=${fmt(g2s.median)} max=${fmt(g2s.max)}\n`);

  console.log("Group 3 (unrelated):");
  console.log(`  top-1 score   min=${fmt(g3s.min)} median=${fmt(g3s.median)} max=${fmt(g3s.max)}\n`);

  // Separation: does group-1 target score sit above group-2 top score?
  const g1Min = g1t.min;
  const g2Max = g2s.max;
  const g2Median = g2s.median;
  console.log("Separation (the load-bearing check):");
  console.log(`  worst G1 target score : ${fmt(g1Min)}`);
  console.log(`  best  G2 near-miss    : ${fmt(g2Max)}   (median ${fmt(g2Median)})`);
  console.log(`  clean margin (G1min - G2max): ${fmt(g1Min - g2Max)}`);
  console.log(`  median margin (G1median - G2median): ${fmt(g1t.median - g2Median)}`);

  const criterion1 = top3Hits === g1.length;
  const criterion2 = g1Min > g2Max; // strict clean separation
  const criterion2Soft = g1t.median > g2Median; // visible separation on medians
  console.log("\nPlan §9 success criteria:");
  console.log(`  (a) every G1 target in top 3        : ${criterion1 ? "PASS" : "FAIL"} (${top3Hits}/${g1.length})`);
  console.log(`  (b) G1 scores separate from G2      : ${criterion2 ? "PASS (clean)" : criterion2Soft ? "PARTIAL (medians separate, ranges overlap)" : "FAIL"}`);

  let verdict: string;
  if (criterion1 && criterion2) verdict = "Retrieval works and scores separate cleanly -> proceed as written; phase-3 threshold plausible.";
  else if (criterion1 && criterion2Soft) verdict = "Retrieval works but duplicate/near-miss scores interleave -> proceed, ranked-list is the ceiling; do not plan on phase 3.";
  else if (criterion1) verdict = "Targets retrieved but no score separation -> ranked list only, no threshold.";
  else verdict = "Retrieval misses G1 targets -> iterate on embed text / query guidance before building catalog infra.";
  console.log(`\nOutcome mapping: ${verdict}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
