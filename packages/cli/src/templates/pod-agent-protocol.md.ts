/**
 * Pod Agent Protocol CLAUDE.md template.
 * Rendered by `pim init` with actual config values.
 */

export const PROTOCOL_MARKER_BEGIN = "<!-- pim-pod-agent-begin -->";
export const PROTOCOL_MARKER_END = "<!-- pim-pod-agent-end -->";

export interface ProtocolTemplateParams {
  podId?: string;
  projectId?: string;
  scope: string;
  serverUrl: string;
}

export function renderPodAgentProtocol(params: ProtocolTemplateParams): string {
  if (params.podId) {
    return renderPodProtocol(params as ProtocolTemplateParams & { podId: string });
  }
  if (params.projectId) {
    return renderProjectProtocol(params as ProtocolTemplateParams & { projectId: string });
  }
  return renderNoTargetProtocol(params);
}

function renderPodProtocol(params: ProtocolTemplateParams & { podId: string }): string {
  return `${PROTOCOL_MARKER_BEGIN}

## PIM — Pod Agent Protocol

This project is connected to PIM pod \`${params.podId}\`.
PIM server: \`${params.serverUrl}\`

### MANDATORY: Session Start Protocol

BEFORE doing any work in this repository, you MUST:
1. Run \`pim context --pod ${params.podId} --scope ${params.scope}\` to pull the latest pod state
2. Review the living doc for current state of all areas
3. Check conflict pressure — if >= 0.6, review open conflicts before proceeding
4. Note any recent updates from other agents that affect your scope (${params.scope})

This is NOT optional. Working without current context risks creating conflicts
and duplicating work that other agents have already completed.

### Automatic Reporting

Context updates are automatically reported to PIM when you:
- **Make a git commit** — via post-commit hook (captures subject, body, changed files)
- **Create a pull request** — via Claude Code hook (captures PR URL and title)

You do not need to manually report routine progress — it flows automatically.

### Manual Reporting

Report these manually using \`pim report\` or the MCP \`submit_context_update\` tool:
- **Blockers**: When you are blocked by another area or dependency
- **Decisions**: When you make a significant architectural or design decision
- **Spec changes**: When you discover the spec needs to change
- **Questions**: When you need input from another role

Example:
\`\`\`bash
pim report --pod ${params.podId} --type decision --scope ${params.scope} \\
  --summary "Chose Redis over Memcached for session cache" \\
  --details "Redis supports pub/sub which we need for real-time invalidation..."
\`\`\`

### Mid-Session Context Refresh

If you have been working for more than 30 minutes or are about to make a major
decision that affects other areas, re-pull context:
\`\`\`bash
pim context --pod ${params.podId} --scope ${params.scope} --brief
\`\`\`

Use \`--diff\` to see only what changed since your last pull.

### Quality Guidelines

- Summaries should be specific and actionable (avoid "made progress" or "working on it")
- Include file paths, function names, or API endpoints when relevant
- Declare blockers and input requests — this triggers PIM's escalation system
- Artifacts (changed files) are automatically included with commit reports

### Conflict Awareness

- Current pod pressure: check with \`PIM pod status ${params.podId}\`
- If pressure is >= 0.8, ingestion is halted — resolve conflicts first
- When your work overlaps with another area, PIM will detect it automatically

### MCP Server

If the PIM MCP server is configured, you can use these tools directly:
- \`submit_context_update\` — report progress, blockers, decisions
- \`query_knowledge\` — search org knowledge for historical precedents
- \`list_pods\` — see all active pods

${PROTOCOL_MARKER_END}`;
}

function renderProjectProtocol(params: ProtocolTemplateParams & { projectId: string }): string {
  return `${PROTOCOL_MARKER_BEGIN}

## PIM — Project Agent Protocol

This repo reports to PIM project \`${params.projectId}\` (long-lived, no sprint pod).
PIM server: \`${params.serverUrl}\`

### Automatic Reporting

Context updates are automatically sent to PIM when you:
- **Make a git commit** — via post-commit hook (captures subject, body, changed files)
- **Create a pull request** — via Claude Code hook (captures PR URL and title)

You do not need to manually report routine progress — it flows automatically.

### Manual Reporting

Report decisions, blockers, and spec changes manually:
\`\`\`bash
pim report --project ${params.projectId} --type decision --scope ${params.scope} \\
  --summary "Chose Redis over Memcached for session cache" \\
  --details "Redis supports pub/sub which we need for real-time invalidation..."
\`\`\`

Types: \`progress\` | \`blocker\` | \`spec_change\` | \`question\` | \`decision\`

### Quality Guidelines

- Summaries should be specific and actionable (avoid "made progress" or "working on it")
- Include file paths, function names, or API endpoints when relevant
- Decisions and spec changes flow into the org knowledge graph automatically

### MCP Server

If the PIM MCP server is configured, you can use these tools directly:
- \`submit_context_update\` — report progress, blockers, decisions
- \`query_knowledge\` — search org knowledge for historical precedents

${PROTOCOL_MARKER_END}`;
}

function renderNoTargetProtocol(params: ProtocolTemplateParams): string {
  return `${PROTOCOL_MARKER_BEGIN}

## PIM — Agent Protocol

This repo has PIM hooks installed but is not connected to a pod or project.
PIM server: \`${params.serverUrl}\`

Hooks are active but updates will not be routed until you link a target:
- To join a sprint: \`pim init --pod <podId>\`
- To link a long-lived project: \`pim init --project <projectId>\`

Linking a project is recommended so your commits contribute to org-level memory.

${PROTOCOL_MARKER_END}`;
}
