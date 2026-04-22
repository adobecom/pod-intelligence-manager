/**
 * Claude Code custom slash command template for /sync.
 * Created in .claude/commands/sync.md by `pim init`.
 */

export interface SyncCommandParams {
  podId?: string;
  projectId?: string;
  scope?: string;
}

/** Placeholder after `pim leave` — no embedded pod ID or project. */
export const DISCONNECTED_SYNC_COMMAND = `This repo is not attached to a PIM pod or project.

To connect, run \`pim init --pod <podId>\` to join a sprint, or \`pim init --project <projectId>\` to link a long-lived project.
`;

export function renderSyncCommand(params: SyncCommandParams): string {
  if (params.podId) {
    const scope = params.scope ?? "your scope";
    return `Pull the latest PIM pod context and summarize what's relevant to your current work.

Steps:
1. Run: pim context --pod ${params.podId} --scope ${scope} --diff
2. If no previous context exists, run without --diff: pim context --pod ${params.podId} --scope ${scope} --brief
3. Parse the output and summarize:
   - Current pod pressure and day number
   - Any open conflicts that affect scope "${scope}"
   - Recent updates from other agents that you should be aware of
   - Relevant org learnings
4. If conflict pressure >= 0.6, warn about potential merge restrictions
5. If there are open conflicts in your scope, list them and recommend reviewing before proceeding
`;
  }

  if (params.projectId) {
    return `Check recent PIM project context for \`${params.projectId}\`.

Steps:
1. Run: pim report --project ${params.projectId} --type progress --summary "Checked in" --dry-run
   (or use the PIM UI to browse recent project updates)
2. Note any recent decisions or spec changes relevant to your work
3. If you have a blocker or decision to record, run:
   pim report --project ${params.projectId} --type <type> --summary "..." --details "..."
`;
  }

  return DISCONNECTED_SYNC_COMMAND;
}
