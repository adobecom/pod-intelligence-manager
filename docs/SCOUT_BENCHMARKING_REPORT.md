# Scout Benchmarking System Report

> **Historical research note.** This snapshot describes another local repository as it existed
> during the cited review; it is not current PIM operational documentation.

Generated for this repo from a local read of `/Users/rkhan/aiResearch/scout`.

This report explains how Scout handles benchmarking so another agent can understand the benchmark design without re-reading the Scout repository. It focuses on benchmark structure, run lifecycle, scoring, artifacts, and the differences between Scout's retrieval evals, agent benchmarks, and read-write benchmarks.

## Executive Summary

Scout uses benchmarks to answer two different questions:

1. Does Scout's retrieval/ranking system return the right code or document surfaces?
2. Does giving an AI coding assistant Scout tools improve answer quality, coverage, cost, latency, and tool-use behavior compared with native file tools?

Those two questions map to two major benchmark families:

- **Search relevance evals**: deterministic IR-style tests over query sets and judged file paths. These compute `NDCG@5`, `NDCG@10`, `MRR`, `Recall@5`, `Recall@10`, and latency.
- **Agent benchmarks**: live runs of Claude Code, Codex CLI, or Cursor Agent against real codebase tasks. Each task is run in a Scout-enabled mode and a baseline mode, then judged with a rubric and summarized with cost, turns, tokens, tool usage, quality, coverage, and optional verified-gold scoring.

Scout's agent benchmarks are operational A/B tests. They evaluate the whole workflow: tool instructions, MCP or CLI wiring, model behavior, search quality, answer synthesis, and cost discipline. They are intentionally closer to "what happens when a real coding assistant uses Scout?" than to a frozen causal protocol.

## Important File Map

Core benchmark docs and outputs:

- `/Users/rkhan/aiResearch/scout/docs/benchmark/README.md`
  - Main benchmark narrative and published results.
  - Defines `quality_10`, `combined_f2`, `combined_gold`, quality-per-dollar charts, and headline tables.
- `/Users/rkhan/aiResearch/scout/docs/benchmark/results/`
  - Per-run output directories.
- `/Users/rkhan/aiResearch/scout/docs/benchmark/gold/`
  - Verified gold answer supersets for agent investigation benchmarks.
- `/Users/rkhan/aiResearch/scout/docs/benchmark/quality-cost.html`
  - Interactive quality/cost chart generated from result summaries.

Read-only agent benchmark scripts:

- `/Users/rkhan/aiResearch/scout/scripts/benchmark.sh`
  - Main Claude Code Photoshop benchmark.
- `/Users/rkhan/aiResearch/scout/scripts/benchmark-dva.sh`
  - DVA monorepo benchmark.
- `/Users/rkhan/aiResearch/scout/scripts/benchmark-horizon.sh`
  - Horizon benchmark.
- `/Users/rkhan/aiResearch/scout/scripts/benchmark-acrobat.sh`
  - Acrobat `consumer` benchmark.
- `/Users/rkhan/aiResearch/scout/scripts/benchmark-codex.sh`
  - Codex CLI read-only benchmark.
- `/Users/rkhan/aiResearch/scout/scripts/benchmark-cursor.sh`
  - Cursor Agent read-only benchmark with `scout`, `scout-cli`, and `baseline` modes.

Read-write agent benchmark scripts:

- `/Users/rkhan/aiResearch/scout/scripts/benchmark-rw.sh`
  - Claude Code read-write implementation benchmark.
- `/Users/rkhan/aiResearch/scout/scripts/benchmark-rw-codex.sh`
  - Codex CLI read-write benchmark.

Scoring and analysis helpers:

- `/Users/rkhan/aiResearch/scout/scripts/bench_score.py`
  - Adds or recalculates `combined_f2` in a run's `summary.csv`.
- `/Users/rkhan/aiResearch/scout/scripts/bench_tool_stats.py`
  - Calculates Scout tool usage, subagent counts, read/expand mix, duplicate reads, duplicate keyword searches.
- `/Users/rkhan/aiResearch/scout/scripts/bench_build_gold.py`
  - Builds verified gold answer supersets from model answers by resolving cited files against a real repo index.
- `/Users/rkhan/aiResearch/scout/scripts/bench_regold_judge.py`
  - Re-judges answers against verified gold and penalizes hallucinated paths.
- `/Users/rkhan/aiResearch/scout/scripts/bench_quality_cost_chart.py`
  - Builds interactive quality/cost charts.
- `/Users/rkhan/aiResearch/scout/scripts/bench_parse_cursor_stream.py`
  - Re-parses Cursor stream output into summary metrics.

Search relevance evals:

- `/Users/rkhan/aiResearch/scout/crates/search_cli/src/evaluation.rs`
  - Core IR metric computation and report rendering.
- `/Users/rkhan/aiResearch/scout/scout_config/evaluations/*.toml`
  - Human-judged query sets.
- `/Users/rkhan/aiResearch/scout/scripts/eval-learned-ranker.sh`
  - Gate script for learned-ranker candidates on a smaller repo set.
- `/Users/rkhan/aiResearch/scout/scripts/eval-all-repos.sh`
  - Cross-repo learned-ranker evaluation.

## Benchmark Families

### 1. Search Relevance Evals

The search relevance harness is the closest thing to a traditional retrieval evaluation.

It is implemented in `crates/search_cli/src/evaluation.rs` and exposed through `scout evaluate`. A query set is a TOML file with:

- A description of the repository.
- `[[queries]]` entries.
- Query IDs.
- Query text.
- Query class:
  - `identifier`
  - `natural_language`
  - `filtered`
- Optional path filters.
- Optional extension filters.
- Optional `definitions_only`.
- A `judgments` block mapping `query_id -> repo_relative_file_path -> relevance_grade`.

Relevance grades are integers from `0` to `3`. Higher is better. Unjudged files are treated as `0`.

For each query, Scout:

1. Runs search against an indexed repository.
2. Maps returned `SearchResult.file_path` values to repo-relative paths.
3. Looks up each returned path in the query's judgments.
4. Computes ranked metrics.
5. Aggregates overall and by query class.

Metrics:

- `NDCG@5`
- `NDCG@10`
- `MRR`
- `Recall@5`
- `Recall@10`
- Mean latency
- Result count

Important implementation details:

- NDCG uses a separate ideal pool containing judged documents not returned by the search. This prevents inflated NDCG when search misses relevant judged files.
- Recall deduplicates by file path. Multiple chunks from the same file count once.
- Reports can be formatted as human-readable text or JSON.

Example query-set location:

- `scout_config/evaluations/dva-query-set.toml`

Learned-ranker evaluation uses this same report shape. Scripts compare a baseline `scout evaluate` result with `scout admin eval-learned` for the candidate model.

### 2. Learned-Ranker Gates

Scout has scripts for model/ranker changes:

- `scripts/eval-learned-ranker.sh`
- `scripts/eval-all-repos.sh`

The smaller gate script runs baseline and candidate learned-ranker evals on a fixed set of repos, then checks acceptance criteria:

- Aggregate `NDCG@5` delta should be positive enough.
- No query class should regress beyond a threshold.

The all-repos script expands this to a larger list of attached repos with matching query sets. It runs evaluations in parallel and prints per-repo aggregate and per-class `NDCG@5` deltas.

This is a deterministic retrieval-quality gate. It does not run an agent and does not judge prose answers.

### 3. Read-Only Agent Benchmarks

The read-only agent benchmark asks codebase-comprehension and change-plan questions. The assistant must inspect the codebase and produce an answer or plan, but must not edit files.

Each benchmark script defines:

- Target repo.
- Model and model label.
- Result directory.
- Max turns.
- Max budget.
- Task filter.
- Judge model.
- Benchmark modes.
- Task prompts.
- Rubrics.
- Coverage totals.

Common target products:

- Photoshop via `scripts/benchmark.sh`
- DVA via `scripts/benchmark-dva.sh`
- Horizon via `scripts/benchmark-horizon.sh`
- Acrobat via `scripts/benchmark-acrobat.sh`

Common read-only modes:

- `scout`: Scout MCP tools enabled.
- `baseline`: Scout disabled; model uses native file tools like Grep, Glob, Read.
- Cursor additionally supports `scout-cli`, where Scout is accessed through shell CLI commands instead of MCP tool schemas.

The main question is: with the same task and model, does Scout improve answer quality and efficiency?

### 4. Read-Write Agent Benchmarks

Read-write benchmarks ask the assistant to implement real code changes and commit them.

Scripts:

- `scripts/benchmark-rw.sh`
- `scripts/benchmark-rw-codex.sh`

Typical tasks include adding APIs, improving error messages, or adding confirmation dialogs. The benchmark:

1. Creates a branch in the target repo for each `(task, mode)` pair.
2. Runs the coding assistant.
3. Captures the resulting git diff.
4. Collects diff stats.
5. Judges the diff with an LLM rubric.
6. Leaves branches for manual inspection.

Read-write scoring is based on the actual diff, not only the final prose answer. The judge prompt explicitly tells the judge to evaluate the diff content and not infer intent.

The verified-gold scoring path is not used for read-write tasks. Scout's docs call out that read-write benchmarks need compile/test-or-diff judging instead of answer-surface gold judging.

## Mode Isolation

Mode isolation is central to Scout's benchmark credibility.

In Scout mode:

- The benchmark provisions a Scout MCP server through an MCP config such as:
  - command: `scout`
  - args: `["mcp"]`
- The assistant receives Scout instructions from the MCP server handshake.
- The prompt often restates critical Scout usage rules:
  - Use Scout tools for all code search.
  - Do not use Grep/Glob/Bash search.
  - Start with `investigate` for change-plan tasks.
  - Verify paths before citing them.
  - Search all relevant platforms.

In baseline mode:

- The benchmark passes an empty MCP config.
- It uses strict MCP config mode so user-level or project-level Scout MCP config cannot leak in.
- Scout MCP tools are explicitly disallowed as defense in depth.
- `Task`/`Agent` subagents are usually disallowed because project hooks can inject Scout instructions into subagents, contaminating baseline mode.
- Baseline instructions say to use native search tools and never use Scout CLI or Scout MCP.

For Claude Code, this is handled with:

- `--mcp-config`
- `--strict-mcp-config`
- `--disallowedTools`
- `--append-system-prompt` for baseline guidance

For Cursor, the script temporarily manages `.cursor/mcp.json`, backs it up, installs an empty config for modes, and restores it on exit.

For Codex, benchmark scripts create isolated Codex home/config contexts so Scout MCP is present only when intended.

## Daemon Warmup

Most Scout benchmarks first verify that the Scout daemon has indexed the target repo.

The common warmup loop:

1. Runs a trivial `scout search "hello" -r <target_repo> -l 1`.
2. Retries for up to 60 attempts.
3. Sleeps 5 seconds between attempts.
4. Aborts if indexing is not ready after roughly five minutes.

The purpose is to keep benchmark failures from silently measuring cold indexing or daemon startup instead of agent behavior.

Some scripts snapshot daemon PIDs before the run and clean up newly spawned benchmark daemons afterward.

## Prompt Design

Scout benchmark prompts are intentionally non-interactive. They usually include:

- The task itself.
- "Do not modify files" for read-only tasks.
- "Do not ask clarifying questions."
- "Make reasonable assumptions and proceed."
- Path verification rules.
- Platform coverage rules.

The benchmark docs note that path verification and platform coverage rules were added after observed hallucination and platform-miss failures.

Path verification rule:

- Never cite a file path unless it was explicitly returned by a tool call.
- Do not infer paths from class names, function names, or directory conventions.
- Confirm uncertain paths with a tool.

Platform coverage rule:

- For multi-platform tasks, explicitly search each platform separately.
- Do not stop after finding one platform's path.

Scout mode frequently adds a stronger rule:

- Use Scout MCP tools for all code search.
- Native search tools are disallowed or discouraged.

## Task Banks and Rubrics

Each product-specific benchmark script contains its own task bank and rubric definitions.

Photoshop read-only tasks include examples like:

- GPU shader compilation across platforms.
- Eyedropper sample size option.
- Drag-and-drop file import trace.
- New blend mode change plan.
- Canvas overlay change plan.
- UXP scripting API method change plan.

DVA tasks include:

- Monorepo app discovery.
- Top included headers.
- GPU shader compilation.
- Premiere/After Effects import traces.
- Startup traces.
- InitializerRegistrar dependency graph.
- Mezzanine refactor plans.

Horizon tasks include:

- Brick lifecycle.
- ECS edit flow.
- Co-editing rebase/conflict behavior.
- Canvas selection flow.
- Asset loading pipeline.
- Keybinding resolution.

Acrobat tasks include:

- OCR modes and engine integration.
- Tesseract integration plan.
- Zlib upgrade impact.
- Undo/redo trace.
- AcroML quit hang analysis.
- Onboarding refactor plan.

Rubrics are explicit coverage checklists. Each task has a `coverage_total`, usually 10, 12, or 15 points depending on complexity. The LLM judge receives the task, rubric, and answer or diff, and returns structured JSON.

## Read-Only Agent Run Lifecycle

The typical lifecycle for a read-only Claude benchmark is:

1. Resolve paths and config:
   - Determine script directory.
   - Determine Scout repo root.
   - Determine target repo path.
   - Create timestamped results directory.
2. Resolve model:
   - Use `MODEL`, `MODEL_ID`, and sometimes `CONTEXT_1M`.
   - Create a label for result paths.
3. Configure benchmark modes:
   - Scout MCP config.
   - Empty baseline MCP config.
   - Baseline prompt.
4. Warm Scout daemon:
   - Run `scout search` until ready.
5. Define task names, task prompts, and rubrics.
6. Optionally prewarm prompt caches:
   - Some Claude scripts run tiny no-op prompts before fanout to populate prompt cache symmetrically.
7. Run each mode/task:
   - Build mode-specific prompt.
   - Run CLI in target repo.
   - Capture stream JSONL.
   - Capture stderr log.
   - Allow nonzero CLI exits without aborting the whole benchmark.
8. Parse transcript:
   - Extract final result object.
   - Extract tool calls from assistant messages.
   - Write `<task>_<mode>.json`.
   - Write `<task>_<mode>.jsonl`.
   - Write `<task>_<mode>_tools.json`.
   - Write `<task>_<mode>.log`.
9. Extract usage:
   - Turns.
   - Input tokens.
   - Cache-read tokens.
   - Cache-create/cache-write tokens.
   - Output tokens.
   - Total cost.
   - Per-model costs when available.
10. Compute tool stats:
   - Scout tool percentage.
   - Subagent calls.
   - Agent types.
   - Expand/read/keyword mix.
   - Duplicate reads.
   - Duplicate keyword searches.
11. Judge answer:
   - Extract assistant answer text from transcript.
   - Build judge prompt with task and rubric.
   - Run judge model with no tools.
   - Parse JSON judge output.
   - Compute `quality_10`.
12. Append a row to `summary.csv`.
13. Post-process:
   - Run `bench_score.py` to add `combined_f2`.
   - Optionally run verified-gold judging.
   - Print mode totals and ratios.
   - Generate or refresh charts separately.

## Parallelism

Scout runs agent tasks in parallel where possible.

In the main Claude script:

- Tasks for a mode can fan out in background shell jobs.
- Modes can also run in parallel because the script no longer mutates target repo `CLAUDE.md`.
- Prewarming is applied symmetrically to scout and baseline modes to avoid cache unfairness.

Cursor is more constrained:

- Modes run sequentially because the script rewrites `.cursor/mcp.json`.
- Tasks can run in parallel within a mode.
- Launches are staggered to avoid Cursor CLI config races.

Parallelism reduces wall clock time but means benchmark scripts must avoid shared mutable state where possible.

## Transcript and Artifact Format

For each read-only task/mode, Scout generally writes:

- `<task>_<mode>.json`
  - Final result object from the agent CLI.
- `<task>_<mode>.jsonl`
  - Full stream JSON transcript.
- `<task>_<mode>.log`
  - Stderr/log output.
- `<task>_<mode>_tools.json`
  - Extracted tool-use blocks.
- `<task>_<mode>_judge.prompt.txt`
  - Prompt sent to judge.
- `<task>_<mode>_judge.jsonl`
  - Judge stream transcript.
- `<task>_<mode>_judge.json`
  - Parsed judge output.
- `<task>_<mode>_judge.log`
  - Judge stderr/log output.
- `summary.csv`
  - One row per task/mode with metrics.

For read-write benchmarks, additional artifacts include:

- Git diff files.
- Diff stats.
- Branch names.
- Commit metadata when available.
- Judge prompt and output for the diff.

For Cursor runs, `run-config.env` records mode/model/repo configuration.

## Summary CSV Columns

The read-only summary rows commonly include:

- `task`
- `mode`
- `wall_s`
- `turns`
- `input_tokens`
- `cache_read`
- `cache_create` or cache write equivalent
- `total_input`
- `output_tokens`
- `cost_usd`
- `scout_pct`
- `agent_calls`
- `agent_types`
- `completeness_10`
- `accuracy_10`
- `depth_10`
- `quality_10`
- `combined_f2` after post-processing
- `coverage_points`
- `coverage_total`
- `models`
- optional `combined_gold`
- optional `halluc_rate`

Not every script has exactly identical columns, especially Cursor and Codex variants, but the intent is consistent.

## Judge Model and Judge Prompt

Scout uses a separate judge pass for most agent benchmarks.

The judge:

- Is typically Claude/Sonnet by default.
- Runs non-interactively.
- Uses max one turn.
- Receives no tools.
- Is told to return JSON only.
- Scores only the answer text or diff.

For read-only tasks, judge JSON includes:

- `completeness`
- `accuracy`
- `depth`
- `coverage_points`
- `coverage_total`
- `strengths`
- `misses`
- `verdict`

For read-write tasks, judge JSON additionally includes:

- `files_changed`

The benchmark script computes:

```text
quality_10 = 0.5 * completeness + 0.3 * accuracy + 0.2 * depth
```

This is a judge-level quality score, not a statistical pass/fail protocol. Coverage is reported separately.

## `combined_f2`

Scout added `combined_f2` because `quality_10` and rubric coverage overlap but are not identical.

The intent:

- Coverage is the recall axis: did the answer find the required surfaces?
- Fidelity is the precision axis: given what it found, was it accurate and deep?
- Completeness is omitted from fidelity to avoid double-counting coverage.

Definitions:

```text
fidelity = (0.6 * accuracy_10 + 0.4 * depth_10) / 10
coverage = coverage_points / coverage_total
combined_f2 = 10 * F2(fidelity, coverage)
```

`F2` weights coverage four times as heavily as fidelity.

There is a hard coverage floor:

- Default floor: `0.50`.
- Below floor: `combined_f2 = 0`.
- Judge failures/unjudged rows are blank, not zero.

The script `bench_score.py` can recompute this idempotently for existing result directories.

Environment overrides:

- `BENCH_F2_BETA`
- `BENCH_F2_W_ACCURACY`
- `BENCH_F2_W_DEPTH`
- `BENCH_F2_COVERAGE_FLOOR`
- `BENCH_F2_SCALE`

## Verified Gold and Hallucination Handling

Scout found that hand-written checklists do not reliably distinguish real file references from fabricated ones. The verified-gold system addresses that.

The verified-gold workflow:

1. Collect answer texts from prior benchmark runs.
2. Extract cited path-like tokens.
3. Build a real file index of the target repo.
4. Resolve each cited token against real repo paths.
5. Split citations into:
   - verified surfaces
   - unverified or hallucinated citations
6. Group verified surfaces by platform/dimension.
7. Cluster repetitive path groups, such as locale variants.
8. Write a gold JSON and gold Markdown file per task.
9. Re-judge each answer against the gold dimensions.
10. Penalize hallucinated cited paths.

Gold scoring:

```text
fidelity = (0.6 * accuracy + 0.4 * depth) / 10
gold_coverage = coverage_points / coverage_total
combined_gold = 10 * F2(fidelity, gold_coverage) * max(0, 1 - hallucination_rate)
```

Some docs describe a steeper hallucination penalty in headline reporting, but the current regold script uses a linear hallucination weight by default.

Important nuance:

- Proposed new files in change-plan answers are not counted as hallucinations if they appear under "new file", "to create", or similar proposal markers.
- This prevents legitimate "create this new file" recommendations from being penalized just because the file does not yet exist.

Gold artifacts:

- `docs/benchmark/gold/<repo>/<task>.json`
- `docs/benchmark/gold/<repo>/<task>.md`
- `<task>_<mode>_regold.json`
- merged `combined_gold` and `halluc_rate` in `summary.csv`

This system applies well to read-only investigation/change-plan tasks. It does not directly apply to read-write tasks, where the output is a diff.

## Tool-Use Metrics

`bench_tool_stats.py` computes behavioral diagnostics from tool-call logs.

It reports:

- `scout_pct`
  - Scout-as-navigator calls divided by total calls.
  - Counts direct `mcp__scout__*` calls.
  - Counts shell commands that run `scout`.
  - Counts `Read` calls after Scout has been invoked, because Scout often returns files that are then read.
- `agent_count`
  - Number of `Task`/`Agent` tool calls.
- `agent_types`
  - Counts by subagent type.
- `expand_pct`
  - Share of calls using `mcp__scout__investigate_expand` or CLI equivalent.
- `read_pct`
  - Share of calls that are raw reads.
- `kw_count`
  - Number of keyword searches.
- `bulk_kw_count`
  - Number of bulk keyword searches.
- `dup_reads`
  - Duplicate reads of the same file/range.
- `dup_kw`
  - Repeated keyword-search queries.

The benchmark scripts print warnings when:

- Scout mode has low Scout usage.
- Scout MCP is not connected.
- The run is read-heavy.
- The model makes many sequential keyword searches instead of batching.
- Duplicate reads are high.
- Duplicate keyword searches are high.

These warnings are diagnostic. They do not directly change quality scores, but they often explain quality or cost regressions.

## Cost and Token Accounting

Scout tracks:

- Wall time.
- Turns.
- New input tokens.
- Cache-read tokens.
- Cache-create/cache-write tokens.
- Total input tokens.
- Output tokens.
- Total cost.
- Per-model cost contributions when the CLI reports them.

Claude scripts usually read `modelUsage` from the result JSON and sum across model IDs.

Codex and Cursor scripts may estimate or calculate cost differently depending on what the CLI exposes:

- Codex scripts use configurable per-million token rates.
- Cursor scripts parse stream usage when present, otherwise estimate from text size.

Cost is central in Scout's published benchmark story. The docs emphasize quality per dollar and interactive quality-cost charts.

## Quality-Cost Charts

`bench_quality_cost_chart.py` renders a self-contained HTML scatter plot.

Chart dimensions:

- X axis: cost per task.
- Y axis: `combined_f2` or `combined_gold`.
- Bubble size: wall time.
- Filled/hollow styling distinguishes Scout and baseline.
- Hover tooltips show sibling comparisons, cost ratios, quality ratios, and hallucination rates.

The chart is meant for operational decision-making: the best value is top-left, meaning high quality and low cost.

## Read-Write Benchmark Details

The read-write benchmark differs from read-only benchmarks in important ways.

It asks the assistant to:

- Modify files.
- Commit changes.
- Produce a branch that can be inspected.

The benchmark itself:

1. Saves the original branch.
2. Creates one branch per task/mode.
3. Runs the assistant with write/edit tools enabled.
4. Captures the diff.
5. Collects files changed and lines added/removed.
6. Builds a judge prompt around the diff.
7. Scores the diff against a task rubric.
8. Leaves branches in place for manual review.

The judge is explicitly instructed:

- Grade only the diff.
- Do not speculate about intended changes.
- Penalize missing platform coverage.
- Penalize unrelated file changes.
- Reward concrete, compilable code changes.

This is less robust than running a full build/test suite, but it is more grounded than judging prose.

## Cursor Benchmark Details

Cursor is treated specially because its CLI and MCP behavior differ from Claude Code.

The Cursor script:

- Uses `agent` CLI.
- Manages `.cursor/mcp.json` in the target repo.
- Backs up and restores the original MCP config.
- Supports modes:
  - `scout`
  - `scout-cli`
  - `baseline`
- Writes `run-config.env`.
- Supports rejudge-only mode.
- Supports appending into an existing result dir.
- Supports comparing a new run against a prior result dir.

Scout cost discipline for Cursor is handled through project hooks and optional prompt injection. The benchmark comments call out a workflow involving memory search, investigate start, mandatory investigate expand, and gap-fill.

Cursor modes are run sequentially so MCP config writes do not race. Tasks can still be parallelized within a mode.

## Codex Benchmark Details

Codex read-only and read-write scripts adapt the same idea to Codex CLI.

They define:

- `MODEL`, defaulting to a GPT-5 family model in the local scripts.
- `EFFORT`.
- Judge model and judge effort.
- Token price environment variables.
- Baseline prompt.
- Task prompts and rubrics.

Scout mode gives Codex Scout MCP access through a generated per-task config/home. Baseline mode runs without Scout MCP.

Codex scripts preserve the same output goal:

- task/mode rows
- cost
- coverage
- quality
- judge artifacts
- summary CSV

## Product-Specific Harnesses

Scout does not have one generic declarative benchmark config for all products. Instead, it uses product-specific shell scripts with embedded task prompts and rubrics.

This has tradeoffs.

Benefits:

- Easy to tune prompts and rubrics for each codebase.
- Benchmark scripts are executable documentation.
- No separate DSL or runner abstraction is needed.
- Product-specific edge cases can be handled directly.

Costs:

- Substantial duplication across scripts.
- Mode-isolation logic must be kept consistent manually.
- Task/rubric changes are code changes.
- Harder to audit than a normalized manifest format.

The `docs/benchmark/README.md` acts as the unifying report layer over those script-specific runs.

## How Scout Publishes Results

The main benchmark README is not just instructions. It is also a running lab notebook and publication artifact.

It records:

- Benchmark definitions.
- Scoring formulas.
- Quality-cost chart links.
- Verified gold results.
- Historical run comparisons.
- Per-product tables.
- Per-task tables.
- Tool usage observations.
- Known regressions.
- Prompt/instruction fixes.
- Learned-ranker shipping notes.

This means Scout's benchmark history is partly in generated result directories and partly curated into the docs.

## Known Failure Modes Scout Tracks

Scout's benchmark docs and scripts explicitly track several recurring failure patterns:

- Scout MCP not connected.
- Low Scout tool usage in Scout mode.
- Model ignoring Scout instructions.
- Excessive raw file reads instead of `investigate_expand`.
- Sequential keyword searches instead of bulk search.
- Duplicate reads.
- Duplicate keyword queries.
- Subagent usage that doubles cost or loses MCP instructions.
- Missing platform coverage.
- Fabricated file paths.
- Judge failures or empty final answers.
- Baseline contamination from project/user MCP config.
- Cursor config races.
- Cold daemon or incomplete indexing.

Some prompt and MCP instruction changes were driven directly by benchmark regressions. For example, the docs describe improvements after agents stopped using `investigate_expand` and missed sibling surfaces.

## Acceptance and Decision Style

Scout does not use one universal statistical claim gate for all agent benchmarks.

For agent benchmark runs, decision-making is mostly comparative and operational:

- Which mode has higher `quality_10`, `combined_f2`, or `combined_gold`?
- Which mode has better coverage?
- Which mode costs less?
- Which mode uses fewer turns?
- Which mode hallucinates fewer paths?
- Which mode has better quality per dollar?
- Did tool-use diagnostics explain a regression?

For search/ranker evals, decision-making is more gate-like:

- Candidate ranker must improve aggregate `NDCG@5`.
- Candidate must avoid unacceptable per-class regressions.

## How This Differs From a Frozen Experimental Protocol

Scout's agent benchmarks are live workflow A/Bs. They intentionally include the full system:

- model behavior
- prompt instructions
- MCP handshake
- tool schemas
- daemon state
- search quality
- answer synthesis
- cost behavior
- tool-use behavior

That makes them realistic but less controlled.

They generally do not freeze:

- target repo state in a holdout manifest
- model version in every run, unless explicitly pinned
- task prompt hashes
- rubric hashes
- exact search index contents
- all generated context
- all external service versions

The search relevance evals are more deterministic because query sets and judgments are explicit. The agent benchmarks are closer to product performance tests.

## Strengths

Scout's benchmarking system is strong in these areas:

- It evaluates realistic coding-assistant workflows, not just isolated retrieval calls.
- It compares Scout and baseline under the same model and tasks.
- It is serious about mode isolation.
- It captures full transcripts and tool logs.
- It tracks cost, turns, tokens, cache behavior, and wall time.
- It has explicit coverage rubrics.
- It post-processes with a coverage-weighted score.
- It has a verified-gold path to penalize hallucinated file citations.
- It uses tool-use diagnostics to improve Scout instructions and tools.
- It supports multiple assistants: Claude Code, Codex CLI, Cursor Agent.
- It supports multiple product codebases.
- It has both read-only and read-write benchmark variants.
- It has deterministic search relevance evals for ranker work.

## Weaknesses and Risks

Key limitations:

- Product-specific shell scripts duplicate a lot of logic.
- Agent benchmark results depend on live model behavior and CLI behavior.
- Some scripts rely on local absolute paths.
- Some scripts allow `|| true` around agent runs, so failure handling depends on downstream parsing.
- LLM judging is inherently noisy.
- Verified gold depends on the union of model-discovered surfaces, so it can miss surfaces no model found.
- Search index freshness and target repo state are operational assumptions, not always frozen artifacts.
- Published docs combine generated metrics with curated commentary.
- Baseline contamination is a known risk and requires many safeguards.
- Read-write benchmarks use diff judging rather than consistently running builds/tests.

## Minimal Mental Model for Another Agent

If you only remember one thing:

Scout has a two-layer benchmark system.

The deterministic layer is `scout evaluate`:

- query set TOML
- judged file paths
- NDCG/MRR/Recall/latency
- used for search and ranker quality

The operational layer is agent A/B benchmarking:

- run the same real codebase task in Scout mode and baseline mode
- capture full agent transcript and tools
- judge final answer or diff with a rubric
- compute quality, coverage, cost, turns, Scout usage
- optionally re-judge against verified gold and hallucination penalties
- summarize in `summary.csv` and benchmark docs

## Practical Reproduction Checklist

To reproduce a Scout-style read-only benchmark:

1. Ensure the target repo is attached and indexed by Scout.
2. Choose the product script, such as `scripts/benchmark.sh` or `scripts/benchmark-horizon.sh`.
3. Set model-related env vars if needed:
   - `MODEL`
   - `MODEL_ID`
   - `CONTEXT_1M`
   - `JUDGE_MODEL`
4. Optionally set:
   - `TASK_FILTER`
   - `BENCH_MODES`
   - `JUDGE=false`
   - `MAX_TURNS`
   - `MAX_BUDGET`
5. Run the script with the target repo path.
6. Inspect the generated result directory under `docs/benchmark/results/`.
7. Inspect `summary.csv`.
8. Recompute `combined_f2` if needed with `bench_score.py`.
9. Run regold judging if gold files exist.
10. Compare Scout vs baseline using quality, coverage, cost, and tool diagnostics.

To reproduce search relevance evals:

1. Pick a query set from `scout_config/evaluations/`.
2. Ensure the matching repo is indexed.
3. Run `scout evaluate -q <query-set> -r <repo> --json`.
4. Compare aggregate and by-class metrics.

## Suggested Borrowable Ideas

Useful ideas to copy into another eval system:

- Store full transcripts and parsed tool calls for every run.
- Treat mode isolation as a first-class benchmark requirement.
- Add explicit path-verification and platform-coverage prompt rules.
- Track tool-use quality, not only final answer quality.
- Add `combined_f2` or an equivalent coverage-weighted secondary score.
- Build verified-gold supersets from real, resolved repo paths.
- Penalize fabricated citations separately from generic accuracy.
- Generate quality-cost plots from `summary.csv`.
- Keep benchmark result directories self-contained.

Ideas to avoid copying blindly:

- Embedding all task banks and rubrics in shell scripts.
- Using LLM-only diff judging as the final read-write verdict when tests are available.
- Treating live agent benchmark results as a statistically controlled claim without additional holdout and drift controls.
