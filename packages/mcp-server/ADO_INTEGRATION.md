# Integrating AI Council MCP into ADO

This guide is for anyone working in the `ado-mcp` repo who wants to add AI Council as a sidecar MCP so that ADO users get Council tools directly in their Claude chat.

## What AI Council MCP provides

Two tools:

| Tool | Input | Output |
|------|-------|--------|
| `list_pods` | (none) | JSON array of active pods with IDs, names, pressure scores, conflict counts |
| `render_pod_dashboard` | `{ pod_id: string }` | A complete single-file React component (36KB) that Claude renders as an artifact — interactive pod dashboard with 4 tabs |

The MCP server is stdio-based and connects to a running Council Fastify server over HTTP. It has one configuration value: the Council server URL.

## Architecture

```
Claude Desktop
  ↓ stdio
ADO MCP Server
  ↓ spawns sidecar (bridge mode via mcp-proxy)
AI Council MCP (stdio → HTTP via mcp-proxy on port 3105)
  ↓ fetch
Council Fastify Server (default http://localhost:4000)
```

ADO's `SidecarManager` wraps the stdio-based Council MCP with `mcp-proxy`, which exposes it as an HTTP endpoint. ADO's `ClientRegistry` then connects to it like any other sidecar.

## Prerequisites

- The `ai-council` repo must be cloned and built:
  ```bash
  cd /path/to/ai-council
  pnpm install
  pnpm --filter @council/mcp-server build
  ```
- The Council server must be running for the tools to return data:
  ```bash
  pnpm --filter @council/server dev   # port 4000
  ```

## Integration steps

### 1. Create the vendor package

Create `vendor/ai-council/` in the ADO repo. Unlike other vendors that install an npm package, this one points to the local build output from the `ai-council` repo.

**`vendor/ai-council/package.json`:**

```json
{
  "name": "ai-council",
  "version": "1.0.0",
  "description": "AI Council MCP server — pod dashboard artifacts for Claude",
  "private": true
}
```

**Entry file:** The registry entry (step 2) should set `vendorPath` to point at the built `dist/index.js` in the `ai-council` repo. For example:

```
vendorPath: "/absolute/path/to/ai-council/packages/mcp-server/dist/index.js"
```

Alternatively, copy the built `dist/` directory into `vendor/ai-council/dist/` and use a relative path:

```
vendorPath: "vendor/ai-council/dist/index.js"
```

The second approach is better for distribution since it doesn't depend on a sibling repo clone.

### 2. Register in tool-registry.json

Add this entry to `src/setup/tool-registry.json`:

```json
{
  "id": "ai-council",
  "name": "AI Council",
  "description": "View pod dashboards, conflicts, and living docs as Claude artifacts. Connects to a running AI Council server.",
  "status": "available",
  "vendorPath": "vendor/ai-council/dist/index.js",
  "sidecarPort": 3105,
  "sidecarMode": "bridge",
  "credentials": [
    {
      "id": "council_api_url",
      "label": "Council Server URL",
      "type": "url",
      "required": true,
      "helpText": "URL of the running Council server (e.g. http://localhost:4000)"
    }
  ],
  "credentialEnvMap": {
    "council_api_url": "COUNCIL_API_URL"
  }
}
```

Key decisions in this config:

- **`sidecarPort: 3105`** — Pick any unused port. Existing vendors use 3101–3103. Port 3105 avoids collisions.
- **`sidecarMode: "bridge"`** — The Council MCP uses stdio transport. ADO's `SidecarManager` will wrap it with `mcp-proxy` to expose `/mcp` (StreamableHTTP) and `/ping` endpoints automatically.
- **`credentials`** — Only one field: the Council server URL. No API keys or tokens are needed (the Council server has no auth in v1).
- **`credentialEnvMap`** — Maps the credential key to the `COUNCIL_API_URL` environment variable that the MCP server reads at startup.

### 3. Add a connection tester (recommended)

The connection tester validates the user's input before saving credentials. It pings the Council server's health endpoint.

**Create `src/integrations/council.ts`:**

```typescript
export async function testCouncilConnection(
  creds: { council_api_url: string }
): Promise<{ success: boolean; error?: string }> {
  const url = creds.council_api_url?.replace(/\/+$/, "");
  if (!url) {
    return { success: false, error: "Council Server URL is required" };
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
      error: `Cannot reach Council server at ${url}: ${msg}`,
    };
  }
}
```

**Register it in `src/setup/server.ts`:**

Add the import at the top:

```typescript
import { testCouncilConnection } from "../integrations/council";
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
  "ai-council": (c) => testCouncilConnection(c as Parameters<typeof testCouncilConnection>[0]),
};
```

### 4. Build and test

```bash
# In the ADO repo
npm run build

# Start ADO (or restart Claude Desktop)
npm start
```

When ADO starts, if the user hasn't configured AI Council yet, the Setup UI at `http://localhost:3001` will show an "AI Council" card with a URL field. The user enters their Council server URL (e.g. `http://localhost:4000`), the connection tester pings `/api/health`, and on success the credential is encrypted and saved.

Once connected, ADO spawns the Council MCP as a bridge sidecar on port 3105. Claude can then call:

- `list_mcp_tools({ tool_id: "ai-council" })` — to see available tools
- Or the tools are available through `mcp.call` workflow steps

## Using in workflows

AI Council tools can be used in ADO workflows via the `mcp.call` step type. Example workflow step that renders a pod dashboard:

```json
{
  "id": "show_pod_dashboard",
  "type": "mcp.call",
  "config": {
    "mcp_id": "ai-council",
    "tool": "render_pod_dashboard",
    "args": {
      "pod_id": "{{ inputs.pod_id }}"
    }
  },
  "on_success": null
}
```

This calls the Council MCP's `render_pod_dashboard` tool with a pod ID from the workflow inputs. The returned React code can be used by Claude to render an artifact.

## Using directly in chat

Once the sidecar is running, users can ask Claude things like:

- *"List all active pods"* — Claude calls `list_pods` via ADO
- *"Show me the dashboard for pod Auth Revamp"* — Claude calls `render_pod_dashboard`, gets back React code, renders it as an artifact in the side panel

Claude sees the tools through ADO's `list_mcp_tools` output and routes calls through the `ClientRegistry`.

## Distribution considerations

For local development, use an absolute `vendorPath` pointing at the `ai-council` repo's built output. For distribution:

1. Copy the built files into `vendor/ai-council/`:
   ```bash
   mkdir -p vendor/ai-council/dist
   cp /path/to/ai-council/packages/mcp-server/dist/*.js vendor/ai-council/dist/
   cp /path/to/ai-council/packages/mcp-server/package.json vendor/ai-council/
   cd vendor/ai-council && npm install --omit=dev
   ```

2. Use a relative `vendorPath` in the registry:
   ```json
   "vendorPath": "vendor/ai-council/dist/index.js"
   ```

3. Add `vendor/ai-council/` to ADO's `setup.sh` or build script so it gets installed alongside the other vendors.

## File changes summary

| File | Action | Description |
|------|--------|-------------|
| `vendor/ai-council/package.json` | Create | Vendor package shell |
| `vendor/ai-council/dist/` | Create | Copied build output from ai-council repo |
| `src/setup/tool-registry.json` | Edit | Add `ai-council` entry |
| `src/integrations/council.ts` | Create | Connection tester (pings `/api/health`) |
| `src/setup/server.ts` | Edit | Import tester + add to `CONNECTION_TESTERS` |

No changes needed to `executor.ts`, `ClientRegistry.ts`, `SidecarManager.ts`, or any other ADO core files. The existing infrastructure handles everything through the registry-driven sidecar pattern.
