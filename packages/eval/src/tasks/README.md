# Eval Task Sets

The task registry is intentionally split by role:

- `primary/real-emc/`: the designated 15-task real EMC eval set. This is the
  default task set for unfiltered eval runs.
- `diagnostics/`: optional probes for smoke testing, archaeology, content
  generation, synthetic context stress, and non-primary real EMC tasks.
- `excluded/`: superseded, saturated, redundant, or otherwise non-headline
  tasks kept for reference and explicit ad-hoc runs.

`task-sets.ts` is the source of truth for named runnable task sets. `index.ts`
imports all registered tasks into `ALL_TASKS`, then exposes:

- `PRIMARY_TASKS`: the designated 15-task headline set.
- `DIAGNOSTIC_TASKS`: diagnostic tasks available by explicit ID/tag.
- `EXCLUDED_TASKS`: retained tasks that should not enter headline comparisons.
- `KG_DECISIVE_TASKS`: reviewed KG-decisive candidates. The runner applies a
  point-in-time KG materiality gate for `--task-set=kg-decisive`.
- `kg-decisive-eligible`: same candidate bank, but the runner filters out tasks
  whose scoped KG block is empty or missing reviewed `kgExpectations`.
- `kg-future-20`: 20 realistic-ticket, future-similar EMC code tasks derived
  from existing frozen KG learnings. This is the preferred KG headline slice for
  "given today's org memory, does KG help with the next similar issue?"
- `kg-future-20-eligible`: same candidate bank, but filtered by the same
  point-in-time KG materiality gate.
- `kg-negative-control`, `kg-lic-favorable`, `kg-control-solvable`: diagnostic
  splits for KG pilots; do not fold them into a KG headline claim.
- `DEFAULT_TASKS`: currently the same as `PRIMARY_TASKS`.

Unfiltered task selection uses `DEFAULT_TASKS`. Explicit `--tasks` or `--tags`
filters still search registered `ALL_TASKS`, so old diagnostics remain runnable
without being confused with the main eval system.

Recommended first-pass KG run for `kg-future-20`:

```sh
pnpm --filter @pim/eval run-eval -- \
  --task-set=kg-future-20 \
  --arms=control,kg-only,pim-full \
  --seeds=5 \
  --run-dir=runs/kg-future-20
```

Add LIC arms only after freezing real LIC fixtures for the new task IDs; the
future set is intentionally KG-derived first, with LIC/complementarity measured
as a follow-up rather than a hidden dependency.

## Leakage-Controlled KG Rebuilds

Claimable KG rebuild experiments must not use eval artifacts as graph source.
Build a source manifest from a frozen product ref before submitting any nodes:

```sh
pnpm --filter @pim/eval kg-source-manifest -- \
  --source-ref <product-source-ref> \
  --org emc-sandbox \
  --out runs/kg-rebuild/source-manifest.json
```

The manifest defaults to product package roots and rejects `packages/eval/**`,
prior run artifacts, LIC fixtures, task IDs, and answer-like KG-future tokens.
Snapshot the graph first, then pass the manifest through the submit stage so
the created node IDs are written for rollback:

```sh
pnpm --filter @pim/eval kg-snapshot -- \
  --org emc-sandbox \
  --out runs/kg-rebuild/graph-before.json

pnpm --filter @pim/eval kg-submit -- \
  --in scripts/classified/<source>.json \
  --org emc-sandbox \
  --source-manifest runs/kg-rebuild/source-manifest.json \
  --experiment-manifest runs/kg-rebuild/submit-manifest.json
```

If the run is bad, reject only the nodes created by that experiment:

```sh
pnpm --filter @pim/eval kg-rollback -- \
  --manifest runs/kg-rebuild/submit-manifest.json
```

Use `--allow-diagnostic` only for non-claimable ablations where targeted or
contaminated input is intentionally being tested.

For the full T3 mining pipeline, pass the same guardrails through the
orchestrator:

```sh
pnpm --filter @pim/eval exec tsx scripts/seed-t3-events.ts \
  --source-manifest runs/kg-rebuild/source-manifest.json \
  --experiment-dir runs/kg-rebuild
```

## Adding a Primary Real EMC Task

1. Add the task file under `primary/real-emc/`.
2. Add its import to `index.ts` and include it in `ALL_TASKS`.
3. Add the task ID to `PRIMARY_15_TASK_IDS` in `task-sets.ts`, replacing another
   primary task if the headline set should remain exactly 15 tasks.
4. Add or update its assignment metadata in `stratification.ts`.

## Adding a Diagnostic Task

1. Add the task file under the appropriate `diagnostics/` subfolder.
2. Register it in `index.ts`.
3. Add its ID to `DIAGNOSTIC_TASK_IDS` in `task-sets.ts`.

## Retiring a Task

Move it to `excluded/`, keep it importable from `index.ts` only if old holdouts
or ad-hoc task IDs still need to resolve, and add its ID to `EXCLUDED_TASK_IDS`.
