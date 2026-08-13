# Plan: Run PIM in a Scout-Style Operational Benchmark

> **Historical benchmark proposal.** Current runnable evaluation workflows live under
> `packages/eval`; this document is retained for design context.

## Goal

Add a Scout-style operational benchmark for PIM without replacing the existing controlled eval protocol.

The benchmark should answer:

> Does giving an AI coding assistant access to PIM improve real coding-task outcomes compared with native code search, Scout/LIC code intelligence, or both together?

This is not a 1:1 replacement for the existing `packages/eval` protocol. It is a second benchmark layer:

- Existing PIM evals: controlled, frozen, causal comparison of context arms.
- New benchmark: live operational A/B/C test of an agent workflow with tool/context access.

## Relationship To The KG Codegen Plan

Keep this as a separate runnable operational harness, while sharing implementation primitives with `packages/eval/KG_CODEGEN_EVAL_ROUNDOUT_PLAN.md`.

The KG codegen plan should answer:

> Did KG/PIM context causally improve generated patches under controlled arms, seeds, task slices, and context budgets?

This operational benchmark should answer:

> Does an AI coding assistant with PIM tools perform better in realistic workflows than baseline, LIC-only, or PIM+LIC modes?

Do not merge the two into one headline score. The controlled protocol can make causal claims; this benchmark can make product/workflow claims. They should share task manifests, rubrics, artifact hashing, patch judging, report rendering, cost accounting, and utilization/tool-use diagnostics, but they should have separate run directories and separate reports.

## Execution Recommendation

Do not start by building this full operational harness end to end. First land the shared eval foundation that both plans need:

- fail-fast task selection
- mode/arm isolation checks
- self-contained result artifacts
- prompt, rubric, context, retrieval, model, and repository hashes
- basic patch apply checks
- utilization and tool-use diagnostics
- cost and latency accounting

Then run the controlled KG/codegen pilot from `packages/eval/KG_CODEGEN_EVAL_ROUNDOUT_PLAN.md` first, because the current priority is whether KG learnings help code generation. This operational benchmark should start immediately after that as a minimal read-only pilot:

- 8 tasks
- 4 modes: `baseline`, `pim`, `lic`, `pim+lic`
- 1 model
- 1 seed
- descriptive report only
- no durable headline claim

Only expand this benchmark to read-write tasks, verified gold, and multi-seed runs after the pilot proves that mode isolation, tool-use accounting, and PIM evidence scoring work.

## Why This Is Not 1:1 With Scout

Scout's benchmark system is optimized for codebase intelligence tools:

- It runs real agents against real product repos.
- It compares tool availability modes.
- It measures answer quality, coverage, cost, turns, and tool-use behavior.
- It judges final answers or diffs.

PIM is not only a code search tool. PIM contains:

- project/pod memory
- decisions
- conflicts
- living docs
- recent updates
- house style and conventions
- team-specific context
- knowledge-graph learnings

Therefore, PIM should not be evaluated only on pure code archaeology tasks. The benchmark needs task strata where PIM plausibly helps.

## Benchmark Questions

Primary operational questions:

1. Does PIM improve agent answer quality over a native-search baseline?
2. Does PIM improve performance on vague-ticket and house-style tasks where code search alone is insufficient?
3. Does combining PIM with code intelligence beat either source alone?
4. Does PIM reduce cost/turns by giving the agent high-signal context early?
5. Does PIM cause regressions by injecting stale, irrelevant, or contradictory context?

Secondary questions:

1. Does PIM help the agent choose the right implementation path faster?
2. Does PIM reduce hallucinated rationale or incorrect team assumptions?
3. Does PIM complement Scout/LIC on multi-file code tasks?
4. Which PIM surfaces help most: full session context, KG-only, living-doc-only, conflicts, recent updates?

## Recommended Modes

Start with these four modes.

### `baseline`

Agent has native code search only.

Allowed:

- shell/file tools
- repo reads
- grep/rg/find
- normal edit tools for read-write tasks

Blocked:

- PIM MCP/CLI
- Scout/LIC MCP/CLI
- any project hook that injects PIM or Scout context

Purpose:

- Operational baseline.
- Measures what the agent can do from repo code alone.

### `pim`

Agent has PIM context/tools but no Scout/LIC code intelligence.

Allowed:

- PIM MCP or PIM CLI
- native file tools

Blocked:

- Scout/LIC MCP/CLI

Purpose:

- Measures PIM's operational lift when the agent can combine PIM context with normal repo search.

### `lic`

Agent has Scout/LIC-style code intelligence but no PIM.

Allowed:

- Scout/LIC MCP or CLI
- native file reads after code-intelligence navigation

Blocked:

- PIM MCP/CLI

Purpose:

- Code-intelligence comparator.
- Equivalent to Scout mode in Scout's benchmark system.

### `pim+lic`

Agent has both PIM and code intelligence.

Allowed:

- PIM MCP/CLI
- Scout/LIC MCP/CLI
- native file reads as needed

Purpose:

- Measures complementarity.
- Most closely matches a deployed "best available context" workflow.

## Optional Later Modes

Add after the first working benchmark.

### `pim-kg-only`

Only PIM KG retrieval exposed.

Purpose:

- Isolate the high-signal memory retrieval block from living docs, conflicts, and recent updates.

### `pim-living-doc-only`

Only living doc context exposed.

Purpose:

- Test whether living docs carry useful task context.

### `pim-conflicts-only`

Only open/resolved conflict context exposed.

Purpose:

- Test tasks involving conflicting team decisions or stale assumptions.

### `pim-stale`

Inject intentionally stale PIM context.

Purpose:

- Negative control for context harm.
- Similar in spirit to existing eval arms like stale/contradictory context.

### `length-matched-neutral`

Inject neutral filler of comparable length.

Purpose:

- Tests whether lift comes from relevant PIM content rather than added text/attention.

## Task Set Design

Do not reuse Scout's pure code-search task set as-is. It would understate PIM because many Scout tasks are designed around finding code surfaces.

Use a mixed task bank with explicit strata.

### Stratum A: Code Archaeology

Agent must find how something works in code.

Expected winner:

- `lic`
- `pim+lic`

PIM may help if prior decisions or known pitfalls exist, but code intelligence should dominate.

Examples:

- Trace an event form save flow.
- Find all call sites of a permission check.
- Map a render or API request path.

Purpose:

- Verify PIM does not harm code-only tasks.
- Show complementarity with code intelligence.

### Stratum B: Vague Ticket

Prompt resembles a real vague issue with missing implementation details.

Expected winner:

- `pim`
- `pim+lic`

Examples:

- "PPN selection is wrong after refresh."
- "Dashboard gating is inconsistent for events users."
- "Session time updates are not reflected until reload."

PIM should supply:

- prior debugging notes
- related conflicts
- recent decisions
- known affected domains
- team assumptions

### Stratum C: House Style / Convention

Task requires knowing local team conventions not obvious from code alone.

Expected winner:

- `pim`
- `pim+lic`

Examples:

- Follow the team's established API payload convention.
- Preserve the chosen 403 fallback behavior.
- Use the current config inheritance model.

PIM should supply:

- decision records
- convention notes
- conflict resolution
- living doc sections

### Stratum D: Multi-File Implementation

Task requires code navigation plus implementation.

Expected winner:

- `pim+lic`
- sometimes `lic`

Examples:

- Add a field across UI, API payload, and cache invalidation.
- Update a validation flow across form, route, and server call.

PIM should help with:

- why the change matters
- known constraints
- stale/blocked alternatives

LIC should help with:

- exact files
- call graph
- symbol references

### Stratum E: Conflict / Decision Resolution

Task asks for a plan or implementation where different agents or teams previously disagreed.

Expected winner:

- `pim`
- `pim+lic`

Examples:

- Choose between fallback behaviors.
- Explain why a prior approach was rejected.
- Implement according to the resolved decision.

### Stratum F: Negative Controls

PIM should not help.

Expected winner:

- no meaningful difference

Examples:

- Generic TypeScript utility.
- Repo-only syntax issue.
- Small single-file algorithmic task.

Purpose:

- Detect prompt bloat, distraction, or harmful over-context.

## Minimum Initial Task Bank

Recommended first version:

- 24 read-only tasks.
- 12 read-write tasks.

Breakdown:

- 4 code archaeology
- 4 vague ticket
- 4 house style
- 4 multi-file implementation
- 4 conflict/decision
- 4 negative controls
- 12 read-write tasks sampled from the same strata, excluding pure prose/content tasks

If cost is a concern, start with:

- 12 read-only tasks
- 4 read-write tasks
- modes: `baseline`, `pim`, `lic`, `pim+lic`
- one model
- one seed

Then expand.

## Candidate Reuse From Existing Eval Tasks

Use existing `packages/eval/src/tasks` as the source of truth where possible.

Good candidates:

- real EMC tasks with `real-emc` tags
- S2 multi-file refactor tasks
- S3 house-style tasks
- S4 vague issue tasks
- S6 archaeology tasks as secondary/code-index-favorable tasks

Avoid, for the first operational run:

- S7 content-only tasks
- heavily saturated tasks
- tasks whose prompt already includes the full implementation checklist
- tasks with pasted source excerpts that erase the value of retrieval

For every borrowed task, create an operational benchmark version:

- read-only plan version, or
- read-write implementation version

## Harness Architecture

Build this as a new package/script layer rather than modifying `packages/eval/src/cli/run.ts`.

Recommended location:

```text
packages/eval/src/ops-bench/
packages/eval/src/cli/run-ops-bench.ts
packages/eval/ops-bench/
```

Alternative if speed matters:

```text
packages/eval/scripts/run-ops-bench.sh
```

Prefer TypeScript for long-term maintainability because the existing eval system is TypeScript and already has:

- task definitions
- pricing
- runners
- report rendering patterns
- artifact hashing helpers

## Proposed Files

```text
packages/eval/src/ops-bench/types.ts
packages/eval/src/ops-bench/modes.ts
packages/eval/src/ops-bench/tasks.ts
packages/eval/src/ops-bench/prompts.ts
packages/eval/src/ops-bench/run-agent.ts
packages/eval/src/ops-bench/parse-transcript.ts
packages/eval/src/ops-bench/tool-stats.ts
packages/eval/src/ops-bench/judge.ts
packages/eval/src/ops-bench/report.ts
packages/eval/src/cli/run-ops-bench.ts
packages/eval/ops-bench/README.md
```

If using shell first:

```text
packages/eval/scripts/run-ops-bench.sh
packages/eval/scripts/ops-bench-tool-stats.py
packages/eval/scripts/ops-bench-score.py
```

But shell should be treated as a pilot path, not the final harness.

## Core Data Model

### `OpsBenchTask`

Fields:

```ts
interface OpsBenchTask {
  id: string;
  sourceTaskId?: string;
  title: string;
  stratum: "code-archaeology" | "vague-ticket" | "house-style" | "multi-file" | "conflict-decision" | "negative-control";
  kind: "read-only" | "read-write";
  targetRepo: string;
  prompt: string;
  rubric: OpsBenchRubric;
  expectedSignals?: string[];
  forbiddenSignals?: string[];
  provenance?: {
    sourceUrl?: string;
    parentSha?: string;
    mergeSha?: string;
  };
  asOf?: string;
}
```

### `OpsBenchMode`

Fields:

```ts
interface OpsBenchMode {
  id: "baseline" | "pim" | "lic" | "pim-lic";
  label: string;
  allowPim: boolean;
  allowLic: boolean;
  allowNativeSearch: boolean;
  promptPreamble: string;
  mcpConfig?: unknown;
  disallowedTools?: string[];
  env?: Record<string, string>;
}
```

### `OpsBenchRow`

Fields:

```ts
interface OpsBenchRow {
  runId: string;
  taskId: string;
  mode: string;
  stratum: string;
  kind: "read-only" | "read-write";
  model: string;
  runner: "claude-code" | "codex" | "cursor";
  wallMs: number;
  turns?: number;
  usage: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  };
  costUsd: number;
  toolStats: ToolStats;
  judge: OpsJudgeResult;
  outputPath: string;
  transcriptPath: string;
  diffPath?: string;
  error?: string;
}
```

## Runner Choice

Start with Claude Code only.

Reasons:

- Scout's main benchmark is Claude Code.
- Stream JSON format is already understood from Scout's scripts.
- Tool allow/block behavior is mature.
- It supports MCP config isolation.

Add Codex later once the benchmark semantics are stable.

## Mode Isolation Requirements

For every mode, explicitly control:

- MCP config.
- CLI/system prompt.
- disallowed tools.
- environment variables.
- project hooks that could inject context.

### Baseline Mode Isolation

Baseline must block:

- PIM MCP tools.
- PIM CLI commands.
- Scout/LIC MCP tools.
- Scout/LIC CLI commands.
- subagents if hooks can inject context.

Baseline prompt:

```text
Use native shell/file tools for code search. Do not use PIM, Scout, LIC, or any related CLI/MCP tools.
Never cite a file path unless it was returned by a tool call.
For multi-platform or multi-layer tasks, search each relevant surface explicitly.
This is non-interactive; make reasonable assumptions and proceed.
```

### PIM Mode Isolation

PIM mode should allow:

- PIM MCP or CLI.
- native file tools.

PIM mode should block:

- Scout/LIC MCP or CLI.

PIM prompt:

```text
PIM is connected. Use PIM first to retrieve project memory, decisions, conflicts, living docs, and recent updates relevant to this task.
Then use native file tools to inspect code as needed.
Do not use Scout/LIC tools.
When citing team decisions or conventions, identify which PIM evidence supports them.
```

### LIC Mode Isolation

LIC mode should allow:

- Scout/LIC MCP or CLI.
- native file reads after navigation.

LIC mode should block:

- PIM MCP or CLI.

Prompt mirrors Scout's benchmark:

```text
Use LIC code-intelligence tools for code search. Do not use PIM.
Verify paths before citing them.
Use native file reads only for files surfaced by LIC or explicit repo navigation.
```

### PIM+LIC Mode Isolation

Combined mode should prescribe order:

1. Query PIM for task context, decisions, and known constraints.
2. Query LIC for code surfaces.
3. Cross-check PIM claims against code where applicable.
4. Write answer or implement change.

Prompt:

```text
Use PIM for project memory and team context. Use LIC for code navigation. Use both before finalizing.
If PIM and code appear to conflict, call that out and prefer verified code behavior for implementation details while preserving PIM decisions/conventions where still applicable.
```

## PIM Integration Options

### Option A: PIM MCP Server

Preferred if available.

Expose tools such as:

- pull session context
- context search
- KG search
- living doc fetch
- conflict lookup
- recent updates lookup

Pros:

- Similar to Scout MCP benchmark mode.
- Cleaner tool-call accounting.
- Easier to isolate by MCP config.

Cons:

- Requires stable MCP tool names and output formats.
- Need to ensure auth and org/project selection are deterministic.

### Option B: PIM CLI

Use existing CLI commands.

Pros:

- Faster to pilot.
- Avoids MCP server/tool schema work.

Cons:

- Harder to count tool usage cleanly.
- Shell commands can leak or vary more.
- Need strict prompts and command allow/block rules.

### Option C: Prompt-Injected Frozen PIM Context

Pre-fetch PIM context and inject it into the prompt.

Pros:

- Closest to current eval arms.
- Deterministic.
- Cheap.

Cons:

- Not Scout-style live tool benchmarking.
- Does not test agent behavior with PIM tools.

Recommendation:

- Pilot with Option C or B if MCP is not ready.
- Final operational benchmark should use Option A.

## Artifact Layout

Use a Scout-like result directory but include PIM-specific metadata.

```text
packages/eval/ops-runs/<run-id>/
  manifest.json
  summary.csv
  report.md
  rows.jsonl
  api-calls.jsonl
  tasks.json
  modes.json
  prompts/
    <task>__<mode>.json
  transcripts/
    <task>__<mode>.jsonl
  outputs/
    <task>__<mode>.md
  tool-calls/
    <task>__<mode>.json
  judge/
    <task>__<mode>.prompt.md
    <task>__<mode>.json
    <task>__<mode>.jsonl
  diffs/
    <task>__<mode>.diff
  pim/
    <task>__<mode>__retrieved-context.json
  lic/
    <task>__<mode>__retrieved-code-context.json
```

`manifest.json` should include:

- run ID
- generated at
- git SHA of this repo
- target repo path
- target repo SHA
- candidate model
- judge model
- runner
- task IDs
- modes
- prompt hashes
- rubric hashes
- PIM org/project/pod config
- LIC index/version info
- environment notes

## Scoring

Use Scout-style scoring for operational comparability, plus PIM-specific diagnostics.

### Read-Only Tasks

Judge returns:

- `completeness_10`
- `accuracy_10`
- `depth_10`
- `coverage_points`
- `coverage_total`
- `pim_evidence_score_0_5`
- `code_evidence_score_0_5`
- `hallucinated_claims`
- `verdict`
- `strengths`
- `misses`

Compute:

```text
quality_10 = 0.5 * completeness + 0.3 * accuracy + 0.2 * depth
fidelity = (0.6 * accuracy + 0.4 * depth) / 10
coverage = coverage_points / coverage_total
combined_f2 = 10 * F2(fidelity, coverage)
```

Add optional PIM-grounding metric:

```text
context_grounding = pim_evidence_score_0_5 / 5
```

Do not blend context grounding into the headline score initially. Keep it diagnostic.

### Read-Write Tasks

Judge the diff, not only the final prose.

Judge returns:

- `completeness_10`
- `accuracy_10`
- `depth_10`
- `coverage_points`
- `coverage_total`
- `files_changed`
- `unrelated_changes`
- `build_or_test_status` if run
- `verdict`

If feasible, add executable checks:

- `pnpm test` targeted package
- TypeScript typecheck
- lint
- patch applies
- selected unit tests

Read-write headline should include:

- LLM diff score
- patch/apply status
- build/typecheck status

## PIM-Specific Diagnostics

Add these fields to every row:

- `pim_tool_calls`
- `lic_tool_calls`
- `native_search_calls`
- `pim_first_call_position`
- `lic_first_call_position`
- `pim_context_tokens`
- `lic_context_tokens`
- `pim_evidence_cited`
- `expected_signals_hit`
- `forbidden_signals_hit`
- `context_conflict_noted`
- `stale_context_used`

The goal is to explain why PIM helped or hurt.

## Tool Statistics

Adapt Scout's `bench_tool_stats.py` concept.

For PIM:

- count PIM MCP calls
- count PIM CLI calls
- classify PIM calls by type:
  - KG search
  - living doc
  - conflict
  - recent updates
  - pod/project context
- count repeated PIM queries
- count no-op PIM calls

For LIC:

- count investigate/search/reference calls
- count expand/read mix
- count duplicate reads/searches

For native:

- count shell `rg`, `grep`, `find`
- count file reads

Compute percentages:

```text
pim_pct = pim_calls / total_tool_calls
lic_pct = lic_calls / total_tool_calls
native_pct = native_calls / total_tool_calls
```

## Verified Gold Strategy

Scout's verified-gold path can be adapted for code-surface coverage, but PIM adds non-file facts.

Use two gold channels:

### Code Gold

Same as Scout:

- extract cited files
- verify against repo
- group by dimension/platform
- penalize fabricated paths

### Context Gold

New PIM-specific gold:

- expected PIM decisions
- expected conflict IDs
- expected living doc sections
- expected KG node summaries/IDs
- expected prior-agent update facts

For context claims, judge should verify:

- Was the relevant decision mentioned?
- Was the cited PIM fact correct?
- Did the answer misuse stale context?
- Did the answer distinguish PIM evidence from code evidence?

This can start manually with `expectedSignals` and mature into a frozen context-gold manifest.

## Report Output

The generated report should include:

1. Executive summary.
2. Overall table by mode:
   - pass/quality
   - combined F2
   - coverage
   - cost
   - cost per quality point
   - turns
   - latency
3. Table by stratum.
4. Table by task.
5. PIM-specific lift:
   - `pim` vs `baseline`
   - `pim+lic` vs `lic`
   - `pim+lic` vs `pim`
6. Regressions:
   - tasks where PIM mode underperformed baseline
   - tasks where combined underperformed LIC
7. Tool-use diagnostics.
8. Hallucination/path verification.
9. Top examples where PIM helped.
10. Top examples where PIM hurt.
11. Recommendations for prompt/tool changes.

## Statistical Treatment

For the pilot, Scout-style descriptive comparison is enough.

For durable claims, add the existing PIM protocol analysis style:

- paired task deltas
- bootstrap confidence intervals
- severe regression rate
- per-stratum reporting
- minimum N threshold

Recommended progression:

1. Pilot: descriptive Scout-style report.
2. Second run: paired bootstrap over task-level quality/pass deltas.
3. Durable claim: frozen task set, prompt hashes, target repo SHA, multi-seed, human/second judge review.

## Implementation Phases

### Phase 0: Decide Scope

Decisions needed:

- Claude Code only, or also Codex?
- Read-only only, or read-only plus read-write?
- PIM MCP, CLI, or prompt-injected context for pilot?
- Use EMC repo tasks only, or add external target repos?

Recommended answers:

- Claude Code only.
- Read-only first.
- PIM MCP if ready, CLI/prompt-injection if not.
- Use existing EMC-derived tasks first.

### Phase 1: Static Task Manifest

Create an operational benchmark task manifest.

Deliverables:

- `packages/eval/ops-bench/tasks.ts`
- 12 initial read-only tasks
- each task assigned a stratum
- each task has rubric and expected signals

Acceptance:

- Tasks can be listed with a CLI flag.
- Rubrics are loaded and rendered into judge prompts.

### Phase 2: Mode Definitions

Create mode definitions.

Deliverables:

- `packages/eval/src/ops-bench/modes.ts`
- baseline/pim/lic/pim+lic modes
- prompt preambles
- MCP config generation
- tool allow/block lists

Acceptance:

- Running in each mode prints the effective config.
- Baseline has no PIM or LIC config.
- PIM mode has no LIC config.
- LIC mode has no PIM config.

### Phase 3: Claude Runner

Implement a Claude Code runner that mirrors Scout's stream JSON capture.

Deliverables:

- `run-agent.ts`
- transcript capture
- result extraction
- tool-call extraction
- usage extraction
- error handling

Acceptance:

- Can run one task in one mode.
- Writes transcript, output, tool calls, and row JSON.

### Phase 4: Judge

Implement read-only answer judge.

Deliverables:

- `judge.ts`
- JSON-only judge prompt
- parse and normalize judge output
- cache optional but not required

Acceptance:

- Can judge one saved output.
- Produces quality, coverage, verdict, strengths, misses.

### Phase 5: Summary and Report

Implement summary generation.

Deliverables:

- `summary.csv`
- `rows.jsonl`
- `report.md`
- mode summary
- stratum summary
- per-task table
- regression section

Acceptance:

- One command produces a readable report for 2 tasks x 2 modes.

### Phase 6: Tool Stats

Adapt Scout-style tool stats.

Deliverables:

- PIM/LIC/native tool call counters
- duplicate query/read detection
- first-call position
- warning generation

Acceptance:

- Report shows whether the agent actually used PIM/LIC in the expected modes.

### Phase 7: Pilot Run

Run:

- 4 tasks
- modes: baseline, pim, lic, pim+lic
- one model
- one seed

Acceptance:

- No mode contamination.
- Report has complete rows.
- Judge parses successfully.
- Tool stats make sense.

### Phase 8: Expand Task Set

Run:

- 12 read-only tasks
- all four modes
- one model
- one seed

Acceptance:

- At least 3 tasks per core stratum.
- Report clearly separates strata.
- Known PIM-favorable tasks show plausible evidence path, even if not always higher score.

### Phase 9: Add Read-Write Tasks

Add branch/diff workflow.

Deliverables:

- branch creation
- diff capture
- optional targeted tests
- diff judge

Acceptance:

- One read-write task runs in baseline and pim+lic.
- Diff is judged.
- Branches are left for inspection or cleaned according to flag.

### Phase 10: Add Verified Gold

Adapt Scout's gold strategy.

Deliverables:

- code-surface gold builder
- PIM context-gold manifest
- regold judge
- hallucination penalties

Acceptance:

- One run can be rejudged against gold.
- `combined_gold` and `halluc_rate` appear in summary.

## CLI Shape

Proposed command shape (the `run-ops-bench` package script was not implemented):

```sh
<eval-runner> run-ops-bench \
  --tasks=headline \
  --modes=baseline,pim,lic,pim-lic \
  --runner=claude-code \
  --model=sonnet \
  --target-repo=/path/to/product-repo \
  --run-dir=ops-runs/<run-id>
```

Useful flags:

```text
--tasks=<id,id|headline|all>
--tags=<tag,tag>
--modes=<mode,mode>
--runner=<claude-code|codex>
--model=<model>
--judge-model=<model>
--target-repo=<path>
--run-dir=<path>
--max-turns=<n>
--max-budget-usd=<n>
--parallel=<n>
--no-judge
--rejudge-only
--read-write
--dry-run
```

## Mode Contamination Checks

Before trusting a run, automatically check:

- baseline transcript contains no PIM tool calls
- baseline transcript contains no LIC tool calls
- PIM transcript contains no LIC tool calls
- LIC transcript contains no PIM tool calls
- MCP init event matches mode expectations
- disallowed tool list was applied
- target repo SHA is recorded
- PIM org/project/pod config is recorded

If contamination is detected:

- mark row invalid
- exclude from aggregate
- surface in report

## Risks

### PIM Looks Weak on Scout-Style Tasks

Mitigation:

- Use balanced task strata.
- Report by stratum.
- Do not headline aggregate across code-only tasks.

### PIM Context Is Stale

Mitigation:

- record PIM retrieval timestamps
- include `asOf` where available
- add stale-context diagnostic
- include negative/stale modes later

### LLM Judge Noise

Mitigation:

- cache judge outputs
- use second judge for headline runs
- add human review for sampled rows
- use executable checks for read-write tasks

### Tool-Mode Leakage

Mitigation:

- strict MCP configs
- explicit blocked tools
- transcript contamination audit
- disable subagents initially

### Cost Blowup

Mitigation:

- one model and one seed for pilot
- start read-only
- use task filters
- cap turns and budget
- run modes sequentially until stable

## Success Criteria

Pilot success:

- One command runs at least 4 tasks across 4 modes.
- Summary and report are generated.
- Tool mode isolation is audited.
- Judge outputs parse for at least 90% of rows.
- Report identifies at least one PIM-help and one PIM-neutral/harm case.

Expanded success:

- 12+ tasks across meaningful strata.
- Per-stratum mode comparisons are stable enough to guide product decisions.
- `pim+lic` can be compared directly to `lic` to assess complementarity.
- Cost and tool-use diagnostics explain major wins/regressions.

Durable success:

- frozen task manifest
- target repo SHAs
- prompt/rubric hashes
- multi-seed
- second judge or human review
- paired bootstrap analysis
- contamination audit

## Recommended First Milestone

Build a minimal read-only Claude Code pilot:

- 8 tasks:
  - 2 code archaeology
  - 2 vague ticket
  - 2 house style
  - 1 conflict/decision
  - 1 negative control
- 4 modes:
  - baseline
  - pim
  - lic
  - pim+lic
- 1 model:
  - Sonnet or current default low-cost capable model
- 1 seed
- no verified gold yet
- no read-write yet

The output should be an operational report, not a headline claim.

After that, use the report to decide:

- whether PIM tool prompts are good enough
- whether tasks need better stratification
- whether PIM+LIC shows complementarity
- whether to invest in read-write support
