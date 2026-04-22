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

### Getting Current Pod Context

When you need to understand the current state of the pod before making decisions
or starting work in an unfamiliar area, pull context with:

\`\`\`bash
pim context --pod ${params.podId} --scope ${params.scope}
\`\`\`

Use \`--brief\` for a quick summary or \`--diff\` to see only what changed since
your last pull. If conflict pressure is >= 0.6, check open conflicts before
proceeding in contested areas.

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

### Quality Guidelines

- Summaries should be specific and actionable (avoid "made progress" or "working on it")
- Include file paths, function names, or API endpoints when relevant
- Declare blockers and input requests — this triggers PIM's escalation system
- Artifacts (changed files) are automatically included with commit reports

### Conflict Awareness

- Check pod pressure with \`pim context --pod ${params.podId} --brief\`
- If pressure is >= 0.8, ingestion is halted — resolve conflicts first
- When your work overlaps with another area, PIM will detect it automatically

### PIM MCP Tools

If the PIM MCP server is configured in Claude Code, you can use these tools
directly instead of CLI commands. They cover the same operations plus additional
querying and management capabilities.

**Context & Session**

| Tool | When to use |
|------|-------------|
| \`get_agent_session_context\` | Pull pod state, living doc, conflicts, and token-budgeted org learnings in one call — the MCP equivalent of \`pim context\` |
| \`context_search\` | Search external sources (Slack archives, Jira, Confluence, GitHub, git) via PIM's aggregated search — no separate Slack/Jira MCPs needed |
| \`query_knowledge\` | Search the org knowledge graph for historical precedents and resolved decisions |

**Reporting**

| Tool | When to use |
|------|-------------|
| \`submit_context_update\` | Report progress, blockers, decisions, spec changes, or questions |

**Conflicts**

| Tool | When to use |
|------|-------------|
| \`get_conflict_details\` | Inspect a specific open conflict and its suggested resolutions |
| \`resolve_conflict\` | Mark a conflict as resolved with a chosen approach |

**Observability**

| Tool | When to use |
|------|-------------|
| \`render_pod_dashboard\` | Get a full interactive React artifact showing pod health, conflicts, feed, and live doc |
| \`list_pods\` | See all active pods in the org |

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

### PIM MCP Tools

If the PIM MCP server is configured in Claude Code, you can use these tools
directly instead of CLI commands.

**Context & Search**

| Tool | When to use |
|------|-------------|
| \`get_project_session_context\` | Pull project state, recent updates, and token-budgeted org learnings — the MCP equivalent of \`pim context --project\` |
| \`context_search\` | Search external sources (Slack archives, Jira, Confluence, GitHub, git) via PIM's aggregated search — no separate Slack/Jira MCPs needed |
| \`query_knowledge\` | Search the org knowledge graph for historical precedents and resolved decisions |

**Reporting**

| Tool | When to use |
|------|-------------|
| \`submit_project_context_update\` | Report progress, blockers, decisions, spec changes, or questions to this project |

**Project Management**

| Tool | When to use |
|------|-------------|
| \`get_project\` | Fetch project details including anatomy and resource configuration |
| \`list_projects\` | See all long-lived projects in the org |

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
