# PIM Eval V2: Redesign Plan

## Summary

Rebuild the PIM evaluation to address the methodology critique of the n=14 V1 eval. V2 uses ~200 real PRs from event-libs as task supply, runs a 2x2 factorial of {Haiku 4.5, Sonnet 4.6} × {control, PIM} with seeded replication, scores against objective signals (unit tests, lint, Playwright) plus a non-Claude LLM judge, and reports confidence intervals on every headline metric.

Target cost: **~$450 per full run on Bedrock public pricing.**

## Background: what V1 got wrong

The first eval landed at 13/14 pass rate. The reviewer correctly identified it as anecdote-grade:

1. n=14 has ±26pp confidence interval; one task flip changes the headline
2. Task categories were curated to favor PIM (8/14 pre-labeled as "PIM should win")
3. Only 2 negative-control tasks, no statistical power on the most important failure mode
4. Run-to-run variance was large relative to sample size
5. Model effect and context effect were confounded in the headline
6. Judge was same family as the agent (Sonnet judging Sonnet)
7. Retry cost multiplier (2.0x) asserted without justification
8. Projection numbers stacked uncertainty without error bars

V2 fixes each of these by construction.

## Design principles

1. **Real tasks, not synthetic.** Source from merged PRs in event-libs so ground truth is a real diff written by a real engineer.
2. **Pre-registration.** Hypotheses, design matrix, analysis plan, and stop rules are locked before any runs.
3. **Both arms get the floor.** `CLAUDE.md` and `.cursor/rules` are loaded for both control and PIM. PIM's claim is value-add, not "context helps."
4. **Objective scoring first.** Unit tests, lint, and Playwright assertions are the primary signal. LLM judge is a backstop.
5. **Confidence intervals everywhere.** Wilson intervals for proportions, McNemar's test for paired binary outcomes, bootstrap for cost-derived numbers.
6. **Different judge family.** Use Gemini 2.5 Pro or GPT-4o for adjudication to avoid same-family scoring bias.

## Task supply: event-libs

`@adobecom/college` is an Adobe AEM/Helix event-page component library at `/Users/rkhan/t3_milo/events-lib/event-libs/`. It has 19 blocks, uniform structure, and 126 merged PRs.

### Why it works as a task source

- 126 merged PRs, most tagged with JIRA tickets (MWPW-xxxxx)
- Uniform block structure: `event-libs/v1/blocks/<name>/<name>.{js,css}` with mirrored tests at `test/unit/blocks/<name>/`
- Conventions are explicit and documented in `.cursor/rules/*.mdc` and `CLAUDE.md`
- Existing test infrastructure: Web Test Runner, ESLint (Airbnb), Stylelint
- AEM dev server (port 3868) which Playwright can drive
- PRs are appropriately scoped: 1-3 files, 20-300 lines typical

### Three task families

#### A. PR Recapitulation (n ≈ 80-120, primary signal)

For each PR at SHA X:
1. Check out parent SHA X^1
2. Task input: PR title + body + linked JIRA description
3. Agent produces a diff
4. Judge:
   - Pre-existing tests at X^1 still pass after diff applied (objective)
   - New tests added in PR X pass after diff applied (objective)
   - `npm run lint` clean (objective)
   - LLM judge: similarity to actual diff on correctness, conventions, completeness

Strongest task type because ground truth is a real merged PR by a real engineer.

#### B. Block-Build From Spec (n ≈ 40-60)

For a sampled set of blocks:
1. Strip block files from working tree (`<name>.js` and `<name>.css`)
2. Task input: block name, behavior spec, authoring example HTML, optional Figma link
3. Agent produces block JS + CSS
4. Judge stack:
   1. Existing WTR unit tests pass (objective)
   2. Lint clean (objective)
   3. Playwright drives the AEM dev server, asserts DOM shape, CSS classes, ARIA, interactions (objective)
   4. Visual diff vs. reference screenshot under tolerance (objective with caveats)
   5. LLM judge code review backstop (subjective)

This is where the Playwright angle shines: most signal is objective.

#### C. Synthetic Negative Control (n ≈ 30-50)

Generic tasks that don't need event-libs context: algorithm puzzles, util refactors, doc cleanup. Tests whether PIM context degrades performance on irrelevant tasks. Fixes the n=2 power problem in V1.

## Experimental design

### Main factorial

|              | Control | PIM |
|--------------|---------|-----|
| Haiku 4.5    | A       | B   |
| Sonnet 4.6   | C       | D   |

3 seeds per cell. Total runs: **200 × 4 × 3 = 2,400.**

### What "control" and "PIM" actually mean

**Both arms get** (the floor):
- `CLAUDE.md` from event-libs and AI Council
- `.cursor/rules/*.mdc` (block-development, css-styling, milo-integration, testing-conventions, utils-and-core)
- `.claude/commands/*.md`
- Full repo read access
- Task description (PR body + JIRA)

**PIM arm additionally gets**:
- Session context (pod state, recent decisions, open conflicts)
- Knowledge graph learnings, scoped and token-budgeted to the task
- Living doc snapshot
- Cross-pod / cross-repo patterns the rules files don't contain

The harness enforces both arms get the floor. Only the PIM-injected payload differs. This isolates PIM's actual contribution from "context exists at all."

### Optional 2x2x2 decomposition (n=50, side experiment)

Hold Sonnet fixed. Cross-cut rules and PIM:

|         | No rules         | Rules on            |
|---------|------------------|---------------------|
| No PIM  | naive baseline   | typical repo agent  |
| PIM     | PIM-only         | full stack          |

Answers "how much value is the static rules vs. PIM's dynamic layer?" Pre-empts the "couldn't we just write better `.cursor/rules`?" objection.

## Judging methodology

### Primary signal: objective tests

For PR-recap tasks:
- WTR unit tests at parent SHA still pass after diff applied
- New tests from the original PR pass after diff applied
- `npm run lint` clean

For block-build tasks:
- WTR block tests pass
- Lint clean
- Playwright assertions on rendered output (DOM, classes, ARIA, interactions)
- Visual diff under tolerance threshold (TBD: ~5% pixel difference)

For negative control:
- Task-specific assertions (unit tests, output equality, etc.)

### Secondary signal: LLM judge

Non-Claude family (Gemini 2.5 Pro or GPT-4o):
- Reviews diff against reference PR
- Scores 1-5 on correctness, convention adherence, completeness, code quality
- Inter-rater reliability with humans validated on 10% sample (Cohen's kappa target > 0.7)

### Why a different judge family

Avoids the bias the reviewer flagged: Sonnet output scored by Sonnet judge has a known style preference. Different family removes that confound.

## Analysis plan (pre-registered)

### Hypotheses (locked before runs)

- **H1**: PIM beats control at fixed model on PR-recap (effect size ≥5pp, p<0.05)
- **H2**: Haiku + PIM ≥ Sonnet + control on PR-recap (non-inferiority within 5pp)
- **H3**: PIM does not degrade performance on negative control (≥ control - 5pp)

### Primary metric

Objective-test pass rate per cell, with Wilson 95% CI.

### Secondary metrics

- LLM judge score (mean, with bootstrap CI)
- Cost-per-pass (with sensitivity bands)
- Convention violation rate (lint failures, class-naming, import patterns)

### Reporting

- All metrics with Wilson 95% confidence intervals
- McNemar's test for paired binary comparisons (within-task)
- Bootstrap (n=10,000) for cost-per-pass and other derived metrics
- Sensitivity tables:
  - Retry multiplier from 1.0x to 3.0x
  - Judge variance impact
  - Task-pool composition (block-build vs PR-recap weighting)
- Distribution plots, not just point estimates

### What we explicitly will not do

- Claim significance from one run
- Report a single point estimate without CI
- Mix measured and projected numbers in the same table
- Use the same model family as both agent and judge

## Cost estimate (Bedrock public pricing)

| Scope | Cost |
|---|---|
| Pilot (Haiku, n=10, 1 seed, both arms) | **~$25** |
| Main eval (n=200, 2x2 × 3 seeds, single-turn) | **~$450** |
| Main eval + 2x2x2 decomposition slice | **~$600** |
| Main eval, multi-turn agentic | **~$1,500-2,500** |

Testing framework cost (WTR, lint, Playwright on existing EC2): under $10 per run.

### Cost driver breakdown for the main $450

| Component | Cost | Why |
|---|---|---|
| Haiku runs (1,200) | ~$70 | Cheap per-run, but many of them |
| Sonnet runs (1,200) | ~$200 | Output at $15/MTok dominates |
| Judge calls (2,400) | ~$96 | One per generation |
| Retry buffer (1.2x) | ~$73 | Failed or flaky runs |

Assumes 5-min prompt cache warmth on the ~19K-token static prefix (rules + conventions). Adobe enterprise Bedrock pricing may reduce these numbers.

## Implementation phases

### Phase 0: Pre-registration (1-2 days, no API cost)

- Lock hypotheses, design matrix, primary metric, stop rules
- Define task selection criteria for each family
- Specify harness protocol (rule loading, context injection)
- Identify judge model and prompts

### Phase 1: Task collection script (2-3 days, no API cost)

- Walk `git log --merges` in event-libs
- For each PR: extract title, body, JIRA ID, parent SHA, changed files, added tests
- Filter to task-eligible PRs (skip dev/stage merges, doc-only changes)
- Output: structured task specs in JSON

### Phase 2: Harness and scorer (3-5 days)

- Worktree-per-task isolation
- Rule-loading enforcer (both arms get the floor)
- PIM context injector (treatment arm only)
- Test runner: WTR + lint at given SHA
- Diff applier and validator
- Judge prompt and adjudicator

### Phase 3: Pilot (1 day, ~$25 API)

- n=10, Haiku-only, single seed, both arms
- Validate harness, rule loading, scorer, judge agreement
- Manual review of all 10 results to calibrate judge

### Phase 4: Main eval (2-4 days wall-clock, ~$450 API)

- Run all 2,400 cells
- Generate reports with CIs, sensitivity tables, distribution plots

### Phase 5: Block-build extension (3-5 days, ~$200 API)

- Add Playwright harness for AEM dev server
- Reference screenshots from current main
- Visual diff threshold calibration
- Run on n=40-60 block-build tasks

### Phase 6: Leadership readout (1 day)

- Headline metrics with CIs
- Decomposition findings
- Sensitivity analysis
- Recommendation: ship config / iterate / abandon

## Open questions

1. **Bedrock enterprise pricing.** Does Adobe have provisioned throughput or volume discount? Public pricing may overstate.
2. **Judge model access.** Do we have Gemini 2.5 Pro or GPT-4o budget, or plan around Claude-only judging with a larger human-validation slice?
3. **Human validation budget.** How many tasks should we human-judge to calibrate the LLM judge? (Suggest 10% = 20 tasks.)
4. **Single-turn vs agentic.** Which mode better reflects how engineers actually use PIM? Single-turn is cheaper and more reproducible; agentic is more realistic. Possibly both, on different slices.
5. **Playwright infra.** Dedicated EC2 box or shared? Affects wall-clock for the block-build phase.

## Non-goals for this eval

- Measuring PIM's value in non-code tasks
- Comparing against other context systems (LlamaIndex, RAG, etc.)
- Measuring PIM's value at multi-day project scale (this is single-task eval)
- Optimizing PIM's own configuration (token budget, retrieval cutoff, etc.)

These are good follow-ups, out of scope for the leadership-readiness eval.
