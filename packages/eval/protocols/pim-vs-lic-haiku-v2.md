# Pre-registered Protocol — PIM context vs locally indexed code (Haiku, v2)

Status: pre-registered. This document is hashed by the holdout manifest
(`holdouts/holdout-haiku-v2.json`) and by every run manifest. Editing it after a
run invalidates that run's provenance chain; cut a new protocol version instead.

Candidate model: `us.anthropic.claude-haiku-4-5-20251001-v1:0`, single turn, no
tools. Judge: see "Judging" below. All numbers in this protocol come from frozen
run artifacts, never from ad-hoc re-runs.

This v2 is the active protocol. Earlier v1 pilot artifacts were removed from the
tree to avoid stale protocol paths and holdout defaults.

## What we are testing

We compare what shared context source an agent receives, holding the model,
prompt, and judging fixed. The context arms are:

- `control` — minimal pod metadata only, no shared context. Operational baseline.
- `length-matched-neutral` — token/attention placebo: no task-relevant facts,
  matched context length. We treat **length-matched-neutral as primary baseline**,
  the primary causal baseline for "context helps".
- `pim-full` — full PIM session context (living doc, conflicts, knowledge-graph
  learnings, recent updates), point-in-time filtered to the task's `asOf`.
- `kg-only` — only the PIM knowledge-graph retrieval block.
- `lic-full` — a frozen locally indexed code block (semantic search hits, symbol
  references, call-graph excerpts) from a point-in-time index of the product repo.
- `lic-pim-combined` — budget-split combined: clipped PIM plus clipped locally
  indexed code, modelling the deployed config where both are available at once.

`lic` throughout means **locally indexed code**: a frozen, point-in-time semantic
index of the product source tree. It is a code-intelligence comparator, not a
third-party product, and is referred to only as locally indexed code / `lic`.

## Hypotheses

### Null Hypothesis

PIM shared context does not change agent task pass rate versus the
length-matched-neutral placebo: the paired per-task pass-rate delta is zero.

### Alternative

PIM shared context raises the paired per-task pass-rate delta above zero on the
headline strata.

## Primary Outcome

The **Primary Outcome** is the paired per-task pass-rate delta between two arms on
the headline task set, collapsed across seeds per task before pairing.

We report each of these paired comparisons (oriented so a positive delta favours
the first arm):

- `pim-full` vs `length-matched-neutral` — does PIM beat the placebo (primary).
- `pim-full` vs `control` — does PIM beat no shared context (operational).
- `pim-full` vs `lic-full` — does PIM beat locally indexed code.
- `kg-only` vs `lic-full` — does PIM memory retrieval alone beat locally indexed code.
- `pim-full` vs `kg-only` — how much of PIM's lift is the knowledge graph.
- `lic-pim-combined` vs `pim-full` and vs `lic-full` — complementarity.

### Estimator

For each comparison we compute the mean paired delta, a 95% confidence interval
from a **paired bootstrap with B = 10,000** resamples over tasks, and the
standardized effect size **Cohen's** dz over the paired deltas. Across the focus
family we control the false discovery rate with **Benjamini-Hochberg** at q = 0.05
and report the adjusted q per comparison.

### Decision rule (per comparison)

- **Strong support**: mean delta ≥ +5pp, bootstrap CI low bound > 0, and
  |Cohen's dz| ≥ 0.5.
- **directional**: mean delta ≥ +5pp but CI or effect size not met.
- **No supported effect**: neither support nor harm.
- **Harm**: mean delta ≤ −5pp or **severe-regression rate** > 0.1.

The **severe-regression rate** is the fraction of paired tasks where the first arm
drops below a passing pass-rate while the second arm passes (or a ≥ 0.4 score
drop). A context source that helps on average but causes harmful regressions does
not earn a headline claim.

## Minimum N

**Minimum N** for a headline claim is **at least 30 tasks** on the headline strata
for this haiku tier. A 30-task paired design with noisy LLM judging is directional;
expand toward 50 real, independently reviewable tasks before a durable claim. We
also require a per-stratum floor so no single stratum carries the result.

## Strata

Tasks are stratified by what kind of help should matter:

- S1 — easy / single-file.
- S2 — multi-file refactor (locally-indexed-code-favorable).
- S3 — house-style / convention (PIM-favorable).
- S4 — vague issue text (PIM-favorable).
- S5 — library integration (locally-indexed-code-favorable).
- S6 — archaeology. Reported **per-stratum exploratory only**: locally indexed
  code (**lic structurally has the answer by construction** here), so S6 is not
  part of the headline mean.
- S7 — content generation. **S7 content-gen excluded** from this eval: it is a
  PIM-only domain where locally indexed code cannot compete, so including it would
  inflate PIM.

Headline strata are S1–S5. Secondary strata (S6) are reported separately and never
folded into the headline numbers.

## Prompt realism tiers

Every task carries a `promptTier`:

- `saturated` — issue plus an exact implementation checklist. Sanity checks only;
  if every arm passes, the harness is sane. These do **not** carry the claim.
- `realistic-ticket` — Jira/issue text plus at most one starting file or component.
  **This is the headline tier.** The primary claim uses only `realistic-ticket`
  tasks, where the sole difference between arms is the context source.
- `underspecified` — vague symptom or outcome; reported separately as a context-
  discovery probe.
- `context-required` — deliberately omits an org convention or prior decision;
  mechanism test for PIM.

The report separates tiers and the headline claim is computed on `realistic-ticket`.

## Freezing and leakage control

PIM context is frozen per task and filtered to the task's `asOf` instant before it
reaches the model: recent updates after `asOf` are dropped, and any conflict,
living-doc section, or knowledge-graph node carrying a timestamp after `asOf` is
dropped. The per-task point-in-time PIM snapshot is persisted in run artifacts and
checked by the temporal audit.

Locally indexed code is frozen from **frozen lic snapshots** built from a
**worktree-per-asOf for all real headline strata** — every real-PR task is indexed
from its parent (pre-merge) SHA, not the live repo HEAD, so the comparator cannot
see code introduced by the very PR the task is derived from. Synthetic tasks have
no merge point and use a fixed snapshot. We hold the residual post-`asOf` leakage
to **under 1pp residual leakage** of headline tasks, audited per task, and exclude
any task whose frozen snapshot is found to leak the answer.

## Judging

Code tasks are judged by executing the candidate against hidden tests. Content
tasks (unified-diff or prose) are judged by an LLM rubric using the hidden ground
truth as reference. To guard rubric judging:

- Diff-output tasks additionally get an **executable patch judge**: the diff is
  applied to the parent-SHA worktree and typechecked / targeted-tested, scoring
  buildability separately from rubric similarity.
- Headline report runs require a **second-judge or blinded human review** with
  inter-rater agreement (Cohen's kappa ≥ **0.6**); runs below that floor are not
  eligible for a headline claim.

## Efficiency diagnostics

Cost and latency are **Efficiency diagnostics** only and never gate the claim.
Cost-per-correct, output-tokens-per-correct, and cache-hit rate are reported as
secondary diagnostics so a context source that wins on pass rate but is far more
expensive is visible, but they do not change the support/harm verdict.

## Changes from earlier pilot runs

- Locally indexed code is frozen from a **worktree-per-asOf for all real headline
  strata** rather than partially freezing only S2 from parent SHAs and leaving
  S1/S3/S4/S5 on repo HEAD.
- The comparator is named only "locally indexed code" / `lic`; no third-party
  product name appears in arms, fixtures, or reports.
- Prompt realism is tiered and the headline claim is restricted to
  `realistic-ticket`.
- The report renders the full protocol claim analysis (every focus comparison with
  CI, dz, BH q, severe-regression rate, and verdict), and always shows PIM vs both
  `control` and `length-matched-neutral`.
- Diff tasks gain an executable patch judge and headline runs require second-judge
  or blinded human review.
