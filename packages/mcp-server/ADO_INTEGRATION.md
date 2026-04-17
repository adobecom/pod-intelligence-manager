# Integrating PIM MCP into ADO

This guide is for anyone working in the `ado-mcp` repo who wants to add PIM as a sidecar MCP so that ADO users get PIM tools directly in their Claude chat.

## What PIM MCP provides

The MCP server is stdio-based and connects to a running PIM Fastify server over HTTP. It has one configuration value: the PIM server URL.

### Tools (22)

Org configuration, long-lived projects, pod lifecycle, agent session bundle, conflicts, tunnels, knowledge graph, and maintenance:

| Tool | Input | Output |
|------|-------|--------|
| `get_org_config` | (none) | Org scope list (ids + labels) |
| `update_org_config` | `scopes` (full replacement list) | Patched org config |
| `list_projects` | (none) | All active projects with anatomy |
| `create_project` | `name`, `description?` | Created project |
| `get_project` | `project_id` | Single project + anatomy |
| `update_project` | `project_id`, `name?`, `description?`, `anatomy?` | Patched project |
| `archive_project` | `project_id` | Archived project snapshot (removes active row; deletes project context stream; unlinks pods; no pod knowledge extraction) |
| `list_pods` | (none) | Active pod summaries |
| `render_pod_dashboard` | `pod_id` | Single-file React component rendered as a Claude artifact |
| `create_pod` | `name`, `sprint_days?`, `milestone_name?` | Created pod with generated ID and default areas |
| `archive_pod` | `pod_id` | Archived pod record + knowledge learnings extracted count |
| `get_agent_session_context` | `pod_id`, `agent_id`, `scope`, optional budgets / `external_query` | Bundled session context (living doc, conflicts, learnings, recent updates) |
| `submit_context_update` | `pod_id`, `agent_id`, `type`, `scope`, `summary`, `details`, `status`, ... | Created pod update + PIM analysis |
| `submit_project_context_update` | `project_id`, same fields as pod context | Created project-level update |
| `get_conflict_details` | `pod_id`, `conflict_id` | Conflict details + downstream pending work |
| `resolve_conflict` | `pod_id`, `conflict_id`, `resolution`, `resolved_by` | Updated conflict record |
| `create_tunnel` | `pod_id`, `dev_name`, `branch`, `port` | Created tunnel record |
| `disconnect_tunnel` | `pod_id`, `tunnel_id` | Disconnected tunnel record |
| `query_knowledge` | `domains?`, `types?`, `text_search?`, `max_tokens?`, ... | Token-budgeted knowledge graph results |
| `context_search` | `query`, `sources?`, `pod_id?`, ... | Cross-source search summary + hits |
| `curate_knowledge_node` | `node_id`, `action`, `edits?` | Curation confirmation |
| `trigger_lint` | `pod_id` | Lint findings array |

### Resources (15)

URI-addressable read-only data that MCP clients can attach to conversations:

| URI | Description |
|-----|-------------|
| `pim://org/pods` | All active pod summaries |
| `pim://org/overlaps` | Cross-pod overlap advisories |
| `pim://org/archived` | Archived pod history |
| `council://org/archived-projects` | Archived initiatives (snapshot + dates) |
| `council://org/config` | Org-wide scope definitions |
| `council://org/projects` | Same payload as `GET /api/projects` (active projects) |
| `pim://knowledge/stats` | Knowledge graph statistics |
| `pim://knowledge/graph` | Full knowledge graph (may be large) |
| `council://projects/{project_id}` | Project metadata and anatomy (listable per active project) |
| `pim://pods/{pod_id}` | Pod metadata, areas, milestone, pressure |
| `pim://pods/{pod_id}/living-doc` | Living document markdown |
| `pim://pods/{pod_id}/conflicts` | All conflicts for a pod |
| `pim://pods/{pod_id}/context-updates` | Context update feed |
| `pim://pods/{pod_id}/tunnels` | Active dev tunnels |
| `pim://pods/{pod_id}/lint-findings` | Lint findings |

Pod- and project-scoped templates support listing — MCP clients can enumerate available pods and projects automatically.

### Prompts (7)

Reusable workflow templates that fetch relevant data and construct structured prompts:

| Prompt | Arguments | Purpose |
|--------|-----------|---------|
| `standup_report` | `pod_id` | Standup from recent activity, conflicts, pressure |
| `conflict_resolution_guide` | `pod_id`, `conflict_id` | Resolution walkthrough with pending work + precedents |
| `pod_health_check` | `pod_id` | Health assessment with blocked areas, lint, recommendations |
| `knowledge_search` | `query`, `domains?` | Search org knowledge graph for learnings |
| `session_context` | `pod_id`, `scope?` | Bundled session start context (living doc, conflicts, learnings, recent updates) |
| `sprint_kickoff` | `name`, `sprint_days?`, `focus_areas?` | Kickoff briefing from org history |
| `pod_retrospective` | `pod_id` | Retrospective before archival |

## Architecture

```
Claude Desktop
  ↓ stdio
ADO MCP Server
  ↓ spawns sidecar (bridge mode via mcp-proxy)
PIM MCP (stdio → HTTP via mcp-proxy on port 3105)
  ↓ fetch
PIM Fastify Server (default http://localhost:4000)
```

ADO's `SidecarManager` wraps the stdio-based PIM MCP with `mcp-proxy`, which exposes it as an HTTP endpoint. ADO's `ClientRegistry` then connects to it like any other sidecar.

## Prerequisites

- The `pim` repo must be cloned and built:
  ```bash
  cd /path/to/pim
  pnpm install
  pnpm --filter @pim/mcp-server build
  ```
- The PIM server must be running for the tools to return data:
  ```bash
  pnpm --filter @pim/server dev   # port 4000
  ```

### Evergreen local development (no manual `vendor/` copy)

ADO resolves the PIM MCP entry in this order:

1. **`PIM_MCP_ENTRY`** — absolute path to `packages/mcp-server/dist/index.js`
2. **`PIM_ROOT`** — absolute path to the `pim` repo root; uses `packages/mcp-server/dist/index.js` if that file exists (after you run `pnpm --filter @pim/mcp-server build`)
3. **`node_modules/@pim/mcp-server/dist/index.js`** — if you `npm link` / `pnpm link` the package or add a `file:` dependency
4. **`vendor/pim/dist/index.js`** — fallback for distribution

Set `PIM_ROOT` in the environment where Claude spawns ADO (e.g. `ado-mcp/.env` loaded by `dotenv`, or your shell profile). Rebuild the MCP after PIM changes:

```bash
pnpm --filter @pim/mcp-server build
```

## Integration steps

### 1. Create the vendor package

Create `vendor/pim/` in the ADO repo. Unlike other vendors that install an npm package, this one points to the local build output from the `pim` repo.

**`vendor/pim/package.json`:**

```json
{
  "name": "pim",
  "version": "1.0.0",
  "description": "PIM MCP server — pod dashboard artifacts for Claude",
  "private": true
}
```

**Entry file:** The registry entry (step 2) should set `vendorPath` to point at the built `dist/index.js` in the `pim` repo. For example:

```
vendorPath: "/absolute/path/to/pim/packages/mcp-server/dist/index.js"
```

Alternatively, copy the built `dist/` directory into `vendor/pim/dist/` and use a relative path:

```
vendorPath: "vendor/pim/dist/index.js"
```

The second approach is better for distribution since it doesn't depend on a sibling repo clone.

### 2. Register in tool-registry.json

Add this entry to `src/setup/tool-registry.json`:

```json
{
  "id": "pim",
  "name": "PIM",
  "description": "Full pod management: create/archive pods, submit updates, resolve conflicts, manage tunnels, search org knowledge, and view dashboards as Claude artifacts.",
  "status": "available",
  "vendorPath": "vendor/pim/dist/index.js",
  "sidecarPort": 3105,
  "sidecarMode": "bridge",
  "credentials": [
    {
      "id": "pim_api_url",
      "label": "PIM Server URL",
      "type": "url",
      "required": true,
      "helpText": "URL of the running PIM server (e.g. http://localhost:4000)"
    }
  ],
  "credentialEnvMap": {
    "pim_api_url": "PIM_API_URL"
  }
}
```

Key decisions in this config:

- **`sidecarPort: 3105`** — Pick any unused port. Existing vendors use 3101–3103. Port 3105 avoids collisions.
- **`sidecarMode: "bridge"`** — The PIM MCP uses stdio transport. ADO's `SidecarManager` will wrap it with `mcp-proxy` to expose `/mcp` (StreamableHTTP) and `/ping` endpoints automatically.
- **`credentials`** — Only one field: the PIM server URL. No API keys or tokens are needed (the PIM server has no auth in v1).
- **`credentialEnvMap`** — Maps the credential key to the `PIM_API_URL` environment variable that the MCP server reads at startup.

### 3. Add a connection tester (recommended)

The connection tester validates the user's input before saving credentials. It pings the PIM server's health endpoint.

**Create `src/integrations/pim.ts`:**

```typescript
export async function testPimConnection(
  creds: { pim_api_url: string }
): Promise<{ success: boolean; error?: string }> {
  const url = creds.pim_api_url?.replace(/\/+$/, "");
  if (!url) {
    return { success: false, error: "PIM Server URL is required" };
  }

  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { success: false, error: `Server returned ${res.status}` };
    }
    const body = await res.json() as { status?: string };
    if (body.status !== "ok") {
      return { success: false, error: "Unexpected health response" };
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Cannot reach PIM server at ${url}: ${msg}`,
    };
  }
}
```

**Register it in `src/setup/server.ts`:**

Add the import at the top:

```typescript
import { testPimConnection } from "../integrations/pim";
```

Add to the `CONNECTION_TESTERS` object:

```typescript
const CONNECTION_TESTERS: Record<
  string,
  (creds: Record<string, string>) => Promise<{ success: boolean; error?: string }>
> = {
  "corp-jira": (c) => testJiraConnection(c as Parameters<typeof testJiraConnection>[0]),
  "figma-mcp": (c) => testFigmaConnection(c as Parameters<typeof testFigmaConnection>[0]),
  github:      (c) => testGithubConnection(c as Parameters<typeof testGithubConnection>[0]),
  "pim": (c) => testPimConnection(c as Parameters<typeof testPimConnection>[0]),
};
```

### 4. Build and test

```bash
# In the ADO repo
npm run build

# Start ADO (or restart Claude Desktop)
npm start
```

When ADO starts, if the user hasn't configured PIM yet, the Setup UI at `http://localhost:3001` will show a "PIM" card with a URL field. The user enters their PIM server URL (e.g. `http://localhost:4000`), the connection tester pings `/api/health`, and on success the credential is encrypted and saved.

Once connected, ADO spawns the PIM MCP as a bridge sidecar on port 3105. Claude can then call:

- `list_mcp_tools({ tool_id: "pim" })` — to see available tools
- Or the tools are available through `mcp.call` workflow steps

## Using in workflows

PIM tools can be used in ADO workflows via the `mcp.call` step type. Example workflow step that renders a pod dashboard:

```json
{
  "id": "show_pod_dashboard",
  "type": "mcp.call",
  "config": {
    "mcp_id": "pim",
    "tool": "render_pod_dashboard",
    "args": {
      "pod_id": "{{ inputs.pod_id }}"
    }
  },
  "on_success": null
}
```

This calls the PIM MCP's `render_pod_dashboard` tool with a pod ID from the workflow inputs. The returned React code can be used by Claude to render an artifact.

## Using directly in chat

Once the sidecar is running, users can ask Claude things like:

- *"List all active pods"* — calls `list_pods`
- *"Show me the dashboard for pod Auth Revamp"* — calls `render_pod_dashboard`, renders React artifact
- *"Create a new pod called Payment Flow Rebuild"* — calls `create_pod`
- *"Submit a progress update for the frontend scope"* — calls `submit_context_update`
- *"Resolve conflict conf-123 on pod-auth"* — calls `resolve_conflict`
- *"Search org knowledge for auth patterns"* — calls `query_knowledge`
- *"Run a health check on pod-checkout"* — invokes the `pod_health_check` prompt
- *"Generate a retro for pod-auth before archiving"* — invokes `pod_retrospective` prompt then `archive_pod`
- *"Archive initiative project-checkout after pods are done"* — calls `archive_project` (or read `council://org/archived-projects` afterward)

Claude sees tools, resources, and prompts through ADO's `list_mcp_tools` output and routes calls through the `ClientRegistry`.

## Distribution considerations

For local development, use an absolute `vendorPath` pointing at the `pim` repo's built output. For distribution:

1. Copy the built files into `vendor/pim/`:
   ```bash
   mkdir -p vendor/pim/dist
   cp /path/to/pim/packages/mcp-server/dist/*.js vendor/pim/dist/
   cp /path/to/pim/packages/mcp-server/package.json vendor/pim/
   cd vendor/pim && npm install --omit=dev
   ```

2. Use a relative `vendorPath` in the registry:
   ```json
   "vendorPath": "vendor/pim/dist/index.js"
   ```

3. Add `vendor/pim/` to ADO's `setup.sh` or build script so it gets installed alongside the other vendors.

## File changes summary

| File | Action | Description |
|------|--------|-------------|
| `vendor/pim/package.json` | Create | Vendor package shell |
| `vendor/pim/dist/` | Create | Copied build output from pim repo |
| `src/setup/tool-registry.json` | Edit | Add `pim` entry |
| `src/integrations/pim.ts` | Create | Connection tester (pings `/api/health`) |
| `src/setup/server.ts` | Edit | Import tester + add to `CONNECTION_TESTERS` |

No changes needed to `executor.ts`, `ClientRegistry.ts`, `SidecarManager.ts`, or any other ADO core files. The existing infrastructure handles everything through the registry-driven sidecar pattern.
