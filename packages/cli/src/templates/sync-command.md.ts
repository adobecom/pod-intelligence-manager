/**
 * Claude Code custom slash command template for /sync.
 * Created in .claude/commands/sync.md by `council init`.
 */

export interface SyncCommandParams {
  podId: string;
  scope: string;
}

/** Placeholder after `council leave` — no embedded pod ID. */
export const DISCONNECTED_SYNC_COMMAND = `This repo is not attached to an AI Council pod.

When you join a sprint again, run \`council init -p <podId>\` to regenerate the /sync workflow.

If this repo is configured for project-level updates only, use \`council report --project <id>\` (and set projectId in .council.json when supported).
`;

export function renderSyncCommand(params: SyncCommandParams): string {
  return `Pull the latest AI Council pod context and summarize what's relevant to your current work.

Steps:
1. Run: council context --pod ${params.podId} --scope ${params.scope} --diff
2. If no previous context exists, run without --diff: council context --pod ${params.podId} --scope ${params.scope} --brief
3. Parse the output and summarize:
   - Current pod pressure and day number
   - Any open conflicts that affect scope "${params.scope}"
   - Recent updates from other agents that you should be aware of
   - Relevant org learnings
4. If conflict pressure >= 0.6, warn about potential merge restrictions
5. If there are open conflicts in your scope, list them and recommend reviewing before proceeding
`;
}
