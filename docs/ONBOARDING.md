# PIM Onboarding

Get the CLI and MCP server running in under 10 minutes.

## Prerequisites

- Node.js 18+
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

## Step 2 — Install the CLI

```bash
npm install -g ado-pim \
  --registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/
```

Verify:

```bash
pim --help
```

## Step 3 — Add PIM to Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` under `mcpServers`:

```json
"pim": {
  "command": "npx",
  "args": ["-y", "@pim/mcp-server@0.1.0"],
  "env": {
    "PIM_API_URL": "https://d1ygncl0yqo6sv.cloudfront.net"
  }
}
```

Restart Claude Desktop. On first launch, `npx` downloads and caches the package.

## Step 4 — Log in to PIM

```bash
pim login
```

This writes `~/.pim/credentials.json` which the MCP server reads automatically for authenticated API calls.

## Step 5 — Initialize a repo (optional)

From any project directory:

```bash
pim init
```

Follow the prompts to link the repo to a pod. This writes a `.pim.json` that sets your org slug and pod ID so you don't have to pass `--pod` flags manually.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `MCP pim: Server disconnected` | Run `pim login` to refresh credentials, then restart Claude Desktop |
| `E403` on `npx @pim/mcp-server` | Re-run Step 1 — your Artifactory token expired |
| `E404` on `npx @pim/mcp-server` | Check `~/.npmrc` — `@pim:registry` must point to `npm-adobe-pim-release`, not `npm-adobe-release` |
| `pim` command not found after install | Add npm global bin to PATH: `export PATH="$(npm bin -g):$PATH"` |
