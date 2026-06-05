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
- `DEFAULT_TASKS`: currently the same as `PRIMARY_TASKS`.

Unfiltered task selection uses `DEFAULT_TASKS`. Explicit `--tasks` or `--tags`
filters still search registered `ALL_TASKS`, so old diagnostics remain runnable
without being confused with the main eval system.

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
