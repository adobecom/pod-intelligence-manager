# Real-EMC eval tasks

Each file in this directory is one real EMC PR replayed as an eval task. Both arms see the same prompt; the PIM arm also gets pod context. The judge scores the agent's diff against the merged patch.

## Adding a new task

1. Pick a recently merged EMC PR. Capture:
   - Linked issue / Jira text (one paragraph is fine)
   - Source file(s) the PR touched, at the parent commit
   - The merged unified diff
   - The pod the PR's work belongs to (e.g. `pod-emc-rbac`, `pod-emc-sessions`, `pod-emc-configs`). If none fits, freeze a new pod fixture first via `pnpm --filter @pim/eval freeze <pod-id>`.

2. Copy `rbac-deprecate-users-json.ts` to a new file. Replace:
   - `id` (must be unique across `ALL_TASKS`)
   - `podId` (the pod the PR's pod context should come from)
   - `SOURCE_FILE` (the parent-commit file contents)
   - `ISSUE_TEXT` (the Jira / GitHub issue body)
   - `GROUND_TRUTH_PATCH` (the merged unified diff)
   - `expectedSignals` (PIM-context-only facts the diff should reference, e.g. conflict IDs, decision dates)
   - `rubric.criteria` (tune to what makes this PR's solution correct)

3. Register the export in `../index.ts` (add the import + push into `ALL_TASKS`).

4. Run: `pnpm --filter @pim/eval run -- --tags=real-emc`

## What the report tells you

The summary table has two PIM-vs-control efficiency columns:

- **Cost / correct (USD)** — total spend divided by passing tasks. PIM-arm adds input cost (context block) but typically passes more tasks; this is the dollar-form TTRR.
- **Output tok / correct** — output tokens divided by passing tasks. The literal "tokens to right response." If PIM context lets the model stop floundering, this drops.

The "PIM saves" diagnostic lists tasks the PIM arm passed and control failed — that's the direct evidence that an org learning translated into shipped code.
