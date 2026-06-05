# Eval System Agent Guide

This guide is a compact map of `packages/eval` for agents that need to operate
the benchmark without rediscovering the whole package.

The package evaluates how different context sources affect an agent's answer to
the same task. It freezes task definitions, PIM context, locally indexed code
context, prompts, outputs, judging results, and audit artifacts so later agents
can prove what the model saw and why a run is or is not claim-eligible.

## Repository Map

- `src/tasks/` defines the task bank.
- `src/tasks/stratification.ts` overlays strata, exclusions, LIC seeds, and real
  task provenance onto tasks.
- `src/tasks/prompt-tiers.ts` classifies prompt realism.
- `src/arms/` defines prompt-building arms.
- `src/cli/freeze.ts` freezes PIM/session-context fixtures.
- `src/cli/lic-freeze.ts` freezes LIC fixtures from the product repo index.
- `src/cli/make-haiku-holdout.ts` writes the haiku v2 holdout manifest.
- `src/cli/run.ts` executes tasks against arms and writes run artifacts.
- `src/judges/` scores candidate outputs.
- `src/rigor/` owns holdout validation, run artifacts, audits, and protocol
  analysis.
- `fixtures/session-contexts/` stores frozen PIM fixtures by pod.
- `fixtures/lic/` stores frozen LIC fixtures by task.
- `holdouts/` stores frozen holdout manifests.
- `protocols/` stores pre-registered protocol documents.
- `reports/` stores ad-hoc markdown reports.

## Core Concepts

### Tasks

Every task implements `Task` from `src/tasks/types.ts`.

Important fields:

- `id`: stable task identifier.
- `type`: `code` or `content`.
- `podId`: PIM fixture key.
- `prompt`: candidate-visible task text.
- `tests`: hidden executable tests for code tasks.
- `rubric`: rubric for content tasks.
- `groundTruth`: hidden reference output used by judges and leakage audits.
- `tags`: filtering and metadata tags, for example `real-emc`.
- `stratum`: S1-S7 category.
- `promptTier`: prompt realism tier, usually inferred by `classifyPromptTier`.
- `licSeed`: deterministic query/symbol seed for the LIC freezer.
- `provenance`: real-task source metadata such as `parentSha`, `mergeSha`, and
  `sourceUrl`.
- `asOf`: point-in-time cutoff for PIM filtering and audits.

`src/tasks/index.ts` keeps all registered tasks importable as `ALL_TASKS`, but
the unfiltered default is `DEFAULT_TASKS`, currently the 15-task `PRIMARY_TASKS`
set listed in `src/tasks/task-sets.ts`. Diagnostic and excluded tasks remain
runnable by explicit `--tasks` or `--tags`, but should not be blended into
headline comparisons.

Most real-task metadata is not declared inline. It is applied by
`applyAssignment` / `applyAssignmentsToAll` in `src/tasks/stratification.ts`.

### Strata

Strata describe why a context source should help:

- `S1`: easy or single-file implementation.
- `S2`: multi-file refactor, generally favorable to code indexing.
- `S3`: house style or team convention, generally favorable to PIM.
- `S4`: vague issue text, generally favorable to PIM.
- `S5`: library or framework integration, generally favorable to code indexing.
- `S6`: archaeology tasks, reported separately because code indexing can contain
  the answer by construction.
- `S7`: content generation tasks, excluded from the PIM-vs-LIC headline protocol.

Headline analyses use S1-S5. S6 and S7 should be treated as secondary or
excluded according to the protocol.

### Prompt Tiers

Prompt realism is separate from stratum:

- `realistic-ticket`: ticket-like prompt with normal starting context.
- `saturated`: prompt includes an implementation checklist or pasted source
  that makes the task heavily specified.
- `underspecified`: vague symptom or outcome.
- `context-required`: intentionally omits an org convention or prior decision.

The mapping lives in `src/tasks/prompt-tiers.ts`. Holdout validation freezes the
tier and detects later tier drift.

### Arms

Arms build the candidate prompt. The runner gives each selected arm the same
task and the frozen fixtures it needs.

Available arms:

- `control`: minimal baseline, no PIM context and no LIC context.
- `length-matched-neutral`: context-length placebo with no task-relevant facts.
- `pim-full`: full PIM session context filtered to the task `asOf`.
- `kg-only`: only the PIM knowledge-graph retrieval block.
- `lic-full`: full LIC context block for the task.
- `lic-pim-combined`: budget-split PIM plus LIC context.
- `pim-clipped`: PIM-only matched-budget sensitivity arm.
- `lic-clipped`: LIC-only matched-budget sensitivity arm.
- `kg-lic`: combined KG plus LIC arm, available for ad-hoc use.

Protocol mode defaults are defined in `DEFAULT_PROTOCOL_ARMS` in
`src/rigor/protocol-analysis.ts`. If a run needs clipped-arm sensitivity rows,
pass the full `--arms=` list explicitly.

## PIM Fixtures

PIM fixtures are stored in `fixtures/session-contexts/<podId>.json`.

The freezer:

```sh
pnpm --filter @pim/eval freeze
```

Default behavior:

- Fetches live KG data from `EVAL_PIM_BASE_URL`, defaulting to the configured
  hosted PIM endpoint.
- Uses `EVAL_PIM_ORG_SLUG`, defaulting to `adobecom`.
- Reads credentials from the normal PIM auth location.
- Falls back to curated offline learnings if live KG fetches fail.
- Can be forced offline with `USE_OFFLINE_LEARNINGS=1`.

Frozen PIM fixtures include:

- `sourceOrgSlug`: org used for the freeze.
- `pulledAt`: fixture creation timestamp.
- pod metadata.
- `livingDocMarkdown`.
- `livingDocSections`, each with `updated_at`, so the living doc can be audited
  section by section.
- conflicts, including `created_at` when available.
- pod-level `relevantLearnings`.
- task-scoped `taskRelevantLearnings`.
- recent updates with timestamps.

PIM context is not sent to the model raw in protocol runs. `pim-full`,
`kg-only`, `pim-clipped`, and `lic-pim-combined` call `filterFixtureByAsOf`
when the task has an `asOf`. That filtered per-task snapshot is also persisted
under `<run-dir>/fixtures/scoped/<taskId>.json`.

The temporal audit checks the scoped fixture, not just the raw pod fixture.

## LIC Fixtures

LIC means locally indexed code. The eval artifacts should keep that name and not
name the backing implementation.

LIC fixtures are stored in `fixtures/lic/<taskId>.json`.

The freezer:

```sh
pnpm --filter @pim/eval lic-freeze -- --task=headline --refresh
```

If the local CLI binary is not named `lic`, set `LIC_BIN`:

```sh
LIC_BIN=<local-lic-cli> pnpm --filter @pim/eval lic-freeze -- --task=headline --refresh
```

Useful flags:

- `--task=headline`: freeze headline tasks.
- `--task=all`: freeze every assigned task.
- `--task=<id,id>`: freeze explicit tasks.
- `--refresh`: overwrite existing fixture files.
- `--dry-run`: show selected tasks and index sources without writing fixtures.
- `--emc-repo=<path>`: override the product repo checkout.
- `--worktree-base=<path>`: override the parent-SHA worktree directory.
- `--head-only`: debug override that indexes the live repo head. Do not use for
  real headline fixtures.

For real headline tasks, `lic-freeze` requires `provenance.parentSha` and indexes
a detached worktree at that parent SHA. This prevents the LIC arm from seeing the
merged PR answer for a task derived from that PR.

Each LIC fixture includes:

- `taskId` and `stratum`.
- recipe names used for retrieval.
- `licDaemonVersion`.
- `indexSource`: either `{ kind: "parentSha", sha, worktree }` or
  `{ kind: "head", repo }`.
- captured LIC calls.
- `renderedBlock`, the prompt-ready LIC markdown block.
- `renderedBlockHash`.
- deterministic `quality` metadata from `deriveLicFixtureQuality`.

The freezer sanitizes captured output so eval artifacts use LIC naming. If older
fixtures still contain the backing product name, run:

```sh
pnpm --filter @pim/eval lic-migrate
```

Holdout validation also fails if a LIC fixture still names the backing product.

## Holdouts

A holdout manifest freezes the task set and metadata used by protocol mode.

Haiku v2 holdout generation:

```sh
pnpm --filter @pim/eval make-haiku-holdout
```

The manifest is written to `holdouts/holdout-haiku-v2.json` and records:

- protocol document path.
- task ids.
- prompt, ground-truth, and rubric hashes.
- `asOf`.
- prompt tier.
- stratum.
- real-task provenance snapshot.
- LIC fixture hash and LIC index source.
- LIC seed hash.
- objective classification metadata.

The holdout protects against drift. If a task prompt, ground truth, rubric,
stratum, prompt tier, `asOf`, provenance, LIC seed, or LIC fixture changes after
holdout creation, protocol mode refuses to run or holdout audit reports the
drift.

Audit a holdout with:

```sh
pnpm --filter @pim/eval audit-holdout -- --holdout=holdouts/holdout-haiku-v2.json
```

## Running Evals

### Ad-hoc Mode

Ad-hoc runs select tasks directly and write a markdown report.

Examples:

```sh
pnpm --filter @pim/eval run-eval -- --arms=control,pim-full
pnpm --filter @pim/eval run-eval -- --tasks=real-emc-ppn-explicit-select --arms=pim-full,lic-full
```

In ad-hoc mode:

- omitting `--tasks=` and `--tags=` selects the 15-task primary set.
- `--tasks=` and `--tags=` select explicitly from all known tasks, including
  diagnostics and excluded tasks.
- `--arms=` selects arms; if omitted, all arms in `src/arms/index.ts` run.
- fixtures are loaded from `fixtures/session-contexts` and `fixtures/lic`.
- output defaults to `reports/<timestamp>.md` unless `--report=` is provided.

### Protocol Mode

Protocol mode runs from a holdout and writes a full artifact directory.

Example:

```sh
pnpm --filter @pim/eval run-eval -- \
  --holdout=holdouts/holdout-haiku-v2.json \
  --protocol=protocols/pim-vs-lic-haiku-v2.md \
  --run-dir=runs/<run-id> \
  --arms=control,length-matched-neutral,pim-full,kg-only,lic-full,lic-pim-combined,pim-clipped,lic-clipped
```

Protocol mode:

- rejects `--tasks` and `--tags`; the holdout is the source of truth.
- rejects `--arm-models`; one fixed candidate model is required across arms.
- validates holdout metadata before running.
- validates task drift before running.
- validates LIC fixture hashes before running.
- defaults to multiple seeds unless `--seeds=` is supplied.
- writes `manifest.json`, prompts, outputs, rows, fixtures, scoped fixtures,
  report, and analysis files under `--run-dir`.

The default protocol candidate and judge models are in `src/cli/run.ts`.
Override with `--model=`, `--runner=`, `--judge-model=`, and `--judge-runner=`
only when intentionally running a new protocol variant.

## Run Artifacts

Protocol runs write:

- `manifest.json`: run metadata, model, runner, arms, tasks, seeds, fixture
  hashes, LIC fixture hashes, task strata, and task `asOf` values.
- `prompts/*.json`: exact candidate-visible prompt segments per task, arm, seed.
- `api-calls.jsonl`: model call metadata and token usage.
- `outputs.jsonl`: candidate outputs plus judge results.
- `rows.jsonl`: report rows used by analysis.
- `fixtures/*.json`: raw PIM fixtures copied into the run.
- `fixtures/lic/*.json`: LIC fixtures copied into the run.
- `fixtures/scoped/*.json`: per-task, `asOf`-filtered PIM snapshots.
- `analysis.json`: protocol analysis.
- `human-review.jsonl`: second-judge or human-review rows, initially empty.
- `patch-judge.jsonl`: executable patch judge rows, created after the run.
- `report.md`: markdown summary rendered by the runner.

Audits read these artifacts, not live code or live services, wherever possible.

## Judging

### Code Tasks

`judgeCode` extracts the largest fenced code block from the candidate output,
transpiles it with TypeScript, appends any task harness, and runs hidden tests in
a temporary Node process.

The code judge returns pass/fail and a score of `1` or `0`.

### Content Tasks

`judgeContent` uses an LLM rubric judge. The candidate never sees ground truth,
but the judge may receive `task.groundTruth.output` as hidden reference material.
Judge results are cached under `fixtures/judge-cache`.

Content pass threshold is implemented in `src/judges/content.ts`.

### Patch Judge

Real EMC diff-output tasks also need executable patch judging:

```sh
pnpm --filter @pim/eval judge-patches -- --run-dir=runs/<run-id> --emc-repo=<product-repo> --typecheck
```

The patch judge applies each candidate diff to the task's parent-SHA worktree and
records whether the patch was checked, applied, skipped, or failed. The judging
audit treats all-skipped patch judging as a failure for headline runs.

## Audits

Protocol document audit:

```sh
pnpm --filter @pim/eval audit-protocol -- --protocol=protocols/pim-vs-lic-haiku-v2.md
```

Holdout audit:

```sh
pnpm --filter @pim/eval audit-holdout -- --holdout=holdouts/holdout-haiku-v2.json
```

Run audits:

```sh
pnpm --filter @pim/eval audit-run -- --type=temporal --run-dir=runs/<run-id>
pnpm --filter @pim/eval audit-run -- --type=leakage --run-dir=runs/<run-id>
pnpm --filter @pim/eval audit-run -- --type=rubrics --run-dir=runs/<run-id>
pnpm --filter @pim/eval audit-run -- --type=judging --run-dir=runs/<run-id>
pnpm --filter @pim/eval analyze-run -- --run-dir=runs/<run-id>
pnpm --filter @pim/eval audit-run -- --type=packet --run-dir=runs/<run-id>
```

What each audit checks:

- `temporal`: scoped PIM fixtures exist for tasks with `asOf`; living doc
  sections, updates, conflicts, and learnings do not exceed the cutoff; rendered
  living doc markdown matches filtered sections.
- `leakage`: ground-truth chunks and provenance values did not leak into prompts
  or copied fixtures.
- `rubrics`: rubrics do not contain PIM-only priming phrases.
- `judging`: content tasks have human or second-judge review rows, agreement is
  acceptable when recorded, and real EMC diff tasks have checked patch-judge rows.
- `analyze`: recomputes protocol analysis from `rows.jsonl`.
- `packet`: writes a reviewer packet from the frozen run artifacts.

## Protocol Analysis

`computeProtocolAnalysis` in `src/rigor/protocol-analysis.ts` derives the report
tables and claim-oriented comparisons.

It computes:

- arm pass-rate summaries.
- headline rows for S1-S5.
- realistic-ticket headline focus rows.
- pairwise paired pass-rate deltas.
- bootstrap confidence intervals.
- standardized effect sizes.
- severe-regression rate.
- per-stratum summaries.
- per-prompt-tier summaries.
- LIC fixture-quality distribution and sensitivity slices.

Focus comparisons are oriented so a positive delta favors the first arm.

## Common Safe Workflows

Refresh PIM fixtures from the default org:

```sh
pnpm --filter @pim/eval freeze
```

Refresh PIM fixtures from an explicit org:

```sh
EVAL_PIM_ORG_SLUG=adobecom pnpm --filter @pim/eval freeze
```

Refresh LIC fixtures for headline tasks:

```sh
pnpm --filter @pim/eval lic-freeze -- --task=headline --refresh
pnpm --filter @pim/eval lic-migrate
```

Run the default 15-task eval set:

```sh
pnpm --filter @pim/eval run-eval -- \
  --arms=control,kg-only,lic-full,kg-lic \
  --seeds=1
```

Generate and audit holdout:

```sh
pnpm --filter @pim/eval make-haiku-holdout
pnpm --filter @pim/eval audit-holdout -- --holdout=holdouts/holdout-haiku-v2.json
```

Run protocol and audits:

```sh
pnpm --filter @pim/eval run-eval -- \
  --holdout=holdouts/holdout-haiku-v2.json \
  --protocol=protocols/pim-vs-lic-haiku-v2.md \
  --run-dir=runs/<run-id> \
  --arms=control,length-matched-neutral,pim-full,kg-only,lic-full,lic-pim-combined,pim-clipped,lic-clipped
pnpm --filter @pim/eval judge-patches -- --run-dir=runs/<run-id> --emc-repo=<product-repo> --typecheck
pnpm --filter @pim/eval audit-run -- --type=temporal --run-dir=runs/<run-id>
pnpm --filter @pim/eval audit-run -- --type=leakage --run-dir=runs/<run-id>
pnpm --filter @pim/eval audit-run -- --type=rubrics --run-dir=runs/<run-id>
pnpm --filter @pim/eval audit-run -- --type=judging --run-dir=runs/<run-id>
pnpm --filter @pim/eval analyze-run -- --run-dir=runs/<run-id>
```

## Things Future Agents Should Not Assume

- Do not edit generated `dist/` files by hand.
- Do not regenerate a holdout until PIM and LIC fixtures are intentionally in the
  state the holdout should freeze.
- Do not use `--head-only` LIC fixtures for real headline tasks except as a
  clearly labeled debug run.
- Do not infer real-task provenance from comments; use structured
  `provenance.parentSha` in the assigned task.
- Do not treat raw PIM fixtures as what the model saw in protocol mode; use
  `fixtures/scoped/<taskId>.json`.
- Do not treat all-skipped patch judging as completed judging.
- Do not rename LIC artifacts to the backing implementation name.
- Do not compare runs if the protocol hash, holdout hash, model, arms, seeds, or
  fixture hashes differ without calling that out.
