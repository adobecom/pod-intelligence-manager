import type { Task } from "../tasks/types.js";
import type { SerenaSeed, SerenaToolCall } from "./types.js";

/**
 * Minimal interface the recipe driver needs from a tool provider. The live MCP
 * client implements this; unit tests pass a fake so recipe/seed logic can be
 * exercised with no Serena process. `call` must never throw — a failed tool
 * call is recorded as `{ ok: false, error }`.
 */
export interface SerenaToolRunner {
  call(tool: string, args: unknown): Promise<SerenaToolCall>;
}

const MAX_SEED_SYMBOLS = 3;
const MAX_SEED_FILES = 3;

/** Looks like a code identifier (PascalCase / camelCase / SNAKE / dotted path), not an English word. */
function isStableIdentifier(token: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$.]{3,}$/.test(token)) return false;
  return /[A-Z]/.test(token) || token.includes("_") || token.includes(".");
}

/**
 * Symbol-first seed derivation. Order (per the plan): reviewed `serenaSeed` →
 * `licSeed.symbol` → stable identifiers in `licSignals`/`expectedSignals`. If no
 * symbol-like seed exists the seed is `source: "none"` and the fixture will be
 * graded no-signal. Ground-truth files are deliberately NOT used as seeds — that
 * would leak the answer's files into a headline fixture.
 */
export function deriveSerenaSeed(task: Task): SerenaSeed {
  const naturalLanguageQuery =
    task.licSeed?.investigateQuery ?? task.prompt.split(/\r?\n/)[0].replace(/^#\s*/, "").slice(0, 120);

  if (task.serenaSeed?.symbols?.length || task.serenaSeed?.files?.length) {
    return {
      symbols: (task.serenaSeed.symbols ?? []).slice(0, MAX_SEED_SYMBOLS),
      files: task.serenaSeed.files?.slice(0, MAX_SEED_FILES),
      patterns: task.serenaSeed.patterns,
      naturalLanguageQuery,
      source: "task-serena-seed",
      note: task.serenaSeed.note,
    };
  }

  if (task.licSeed?.symbol) {
    return { symbols: [task.licSeed.symbol], naturalLanguageQuery, source: "lic-seed" };
  }

  const derived = Array.from(
    new Set([...(task.licSignals ?? []), ...(task.expectedSignals ?? [])].filter(isStableIdentifier)),
  ).slice(0, MAX_SEED_SYMBOLS);
  if (derived.length > 0) {
    return { symbols: derived, naturalLanguageQuery, source: "reviewed-derived" };
  }

  return { symbols: [], naturalLanguageQuery, source: "none" };
}

/** Pull `relative_path` hints out of a tool output, tolerant of format drift. */
function discoverRelativePaths(output: string): string[] {
  const paths = new Set<string>();
  for (const m of output.matchAll(/"relative_path"\s*:\s*"([^"]+)"/g)) paths.add(m[1]);
  for (const m of output.matchAll(/\b([\w./-]+\.(?:tsx?|jsx?|mjs|cjs))\b/g)) paths.add(m[1]);
  return Array.from(paths);
}

/**
 * Drive the deterministic, per-stratum Serena recipe. Reference/diagnostics tools
 * need the symbol's defining file, which is learned from the first `find_symbol`
 * result — so the recipe is partially dynamic (find_symbol → chain). Returns the
 * ordered recipe step names and the recorded tool calls.
 */
export async function runRecipe(
  runner: SerenaToolRunner,
  task: Task,
  seed: SerenaSeed,
): Promise<{ recipe: string[]; calls: SerenaToolCall[] }> {
  const recipe: string[] = [];
  const calls: SerenaToolCall[] = [];
  const stratum = task.stratum;
  const symbols = seed.symbols.slice(0, MAX_SEED_SYMBOLS);
  const seedFiles = (seed.files ?? []).slice(0, MAX_SEED_FILES);
  const discoveredFiles = new Set<string>(seedFiles);

  const run = async (name: string, tool: string, args: unknown): Promise<SerenaToolCall> => {
    recipe.push(name);
    const call = await runner.call(tool, args);
    calls.push(call);
    if (call.ok) for (const p of discoverRelativePaths(call.output)) discoveredFiles.add(p);
    return call;
  };

  // Orientation: when reviewed seed files are present, get their symbol overview
  // for EVERY stratum. This gives the fixture real evidence (the file's top-level
  // symbols) even when a symbol-name lookup doesn't resolve — the difference
  // between a no-signal fixture and a useful one for vague/house-style tasks.
  for (const file of seedFiles) {
    await run("get_symbols_overview", "get_symbols_overview", { relative_path: file });
  }

  // find_symbol for every seed symbol — the backbone of every recipe.
  // Serena's arg is `name_path_pattern`; the result JSON carries the defining
  // `relative_path`, which downstream reference/diagnostics tools require.
  for (const symbol of symbols) {
    await run("find_symbol", "find_symbol", { name_path_pattern: symbol, include_body: true });
  }

  const primaryFiles = Array.from(discoveredFiles).slice(0, MAX_SEED_FILES);
  const primaryFile = primaryFiles[0];

  switch (stratum) {
    case "S2": {
      if (primaryFile) {
        for (const symbol of symbols) {
          await run("find_referencing_symbols", "find_referencing_symbols", { name_path: symbol, relative_path: primaryFile });
          await run("find_implementations", "find_implementations", { name_path: symbol, relative_path: primaryFile });
        }
        for (const file of primaryFiles) await run("get_diagnostics_for_file", "get_diagnostics_for_file", { relative_path: file });
      }
      break;
    }
    case "S5": {
      if (primaryFile) {
        for (const symbol of symbols) {
          // find_declaration is regex-in-file (relative_path + regex), not symbol-name based.
          await run("find_declaration", "find_declaration", { relative_path: primaryFile, regex: symbol });
          await run("find_implementations", "find_implementations", { name_path: symbol, relative_path: primaryFile });
        }
        for (const file of primaryFiles) await run("get_diagnostics_for_file", "get_diagnostics_for_file", { relative_path: file });
      }
      break;
    }
    case "S6": {
      if (primaryFile) {
        for (const symbol of symbols) {
          await run("find_referencing_symbols", "find_referencing_symbols", { name_path: symbol, relative_path: primaryFile });
        }
      }
      break;
    }
    case "S1": {
      if (primaryFile) await run("get_diagnostics_for_file", "get_diagnostics_for_file", { relative_path: primaryFile });
      break;
    }
    case "S3":
    case "S4": {
      // Symbol lookup only by default (no NL guessing). When seed files are
      // present, add diagnostics on them so house-style/vague tasks still carry
      // real type/lint evidence for the relevant file.
      for (const file of seedFiles) await run("get_diagnostics_for_file", "get_diagnostics_for_file", { relative_path: file });
      break;
    }
    default:
      break;
  }

  return { recipe, calls };
}
