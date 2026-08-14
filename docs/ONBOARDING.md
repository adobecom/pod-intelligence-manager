# PIM Onboarding

Get the CLI and MCP server running in under 10 minutes.

## Prerequisites

- Node.js 24+
- Access to Adobe Artifactory (`artifactory-uw2.adobeitc.com`)

## Step 1 — Authenticate with Artifactory

Run once. Uses Adobe SSO — no API key needed.

```bash
npm login \
  --registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/ \
  --auth-type=web \
  --scope=@pim
```

> **Note:** If your `~/.npmrc` already has `@pim:registry` pointing elsewhere (e.g. `npm-adobe-release`), update it to `npm-adobe-pim-release`. The `@pim` packages live only on that registry.

## Step 2 — Install the CLI and MCP server

`ado-pim` is unscoped, so pass `--registry` explicitly (scoped `@pim/*` packages also resolve correctly with this flag):

```bash
npm install -g ado-pim @pim/mcp-server \
  --registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/
```

Verify:

```bash
pim --help
```

## Step 3 — Add PIM to Claude Desktop

Add this under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pim": {
      "command": "node",
      "args": ["/opt/homebrew/lib/node_modules/@pim/mcp-server/dist/index.js"],
      "env": {
        "PIM_API_URL": "https://d1ygncl0yqo6sv.cloudfront.net"
      }
    }
  }
}
```

> **Path:** The example above is for Apple Silicon Homebrew Node (`/opt/homebrew`). On Intel Macs or other installs, run `npm root -g` and use `<that-path>/@pim/mcp-server/dist/index.js`.

Restart Claude Desktop. It runs the installed binary directly — no registry hit on startup, so an expired Artifactory token won't break MCP after install. Re-run Step 2 only when upgrading packages.

## Step 4 — Log in to PIM

```bash
pim login
```

This writes `~/.pim/credentials.json`, which the MCP server reads automatically for authenticated API calls.

If you use Claude Desktop without a linked repo, set your org in the MCP `env` block: `"PIM_ORG_SLUG": "your-org-slug"`. Otherwise org comes from the repo's `.pim.json` (via `pim init`) or the MCP `set_active_org` tool.

## Step 5 — Initialize a repo (optional)

From any project directory:

```bash
pim init
```

Follow the prompts to link the repo to a pod. This writes `.pim.json` (org slug, pod ID, and optionally project, scope, and agent ID) so you don't have to pass `--pod` flags manually. It also wires **Claude Code** (`.claude/settings.json`, hooks, `CLAUDE.md`) — it does **not** edit Claude Desktop's `claude_desktop_config.json`; Step 3 is still required for Desktop.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `MCP pim: Server disconnected` | Run `pim login` to refresh credentials, then restart Claude Desktop |
| `E403` on `npm install -g` (Step 2) | Re-run Step 1 — your Artifactory token expired |
| `E404` on `npm install -g ado-pim` | Add `--registry=…/npm-adobe-pim-release/` as in Step 2; unscoped installs default to the public npm registry |
| `E404` on `npm install -g @pim/mcp-server` | Check `~/.npmrc` — `@pim:registry` must point to `npm-adobe-pim-release`, not `npm-adobe-release` |
| `Cannot find module` on Claude Desktop start | The `args` path in `claude_desktop_config.json` is wrong — re-run `npm root -g` and fix the path |
| Org-scoped MCP tools fail / 401 on org routes | Run `pim login`; set `PIM_ORG_SLUG` in Desktop `env`, run `pim init` in a repo, or use MCP `set_active_org` |
| `pim` command not found after install | Add npm's global bin directory to PATH: `export PATH="$(npm prefix -g)/bin:$PATH"` |
