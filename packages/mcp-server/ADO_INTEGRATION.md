# Integrating the PIM MCP server into ADO

**Status:** current PIM-side contract as of 2026-08-13. ADO registry and sidecar details live in
the ADO repository and should be checked there before changing that project.

This guide covers the interactive, stdio `@pim/mcp-server` package. It is distinct from the
restricted, service-token-only Memory endpoint at `POST /mcp/memory`.

## Runtime contract

- Node.js 24 or newer.
- Executable: `pim-mcp` (package entry: `@pim/mcp-server/dist/index.js`).
- Transport: MCP over stdio.
- Backend: the Fastify PIM API selected by `PIM_API_URL`; local default is
  `http://localhost:4000`.
- Authentication: Adobe IMS credentials from `~/.pim/credentials.json`, normally created by
  `pim login` or the MCP `authenticate` / `complete_authentication` flow.
- Organization selection, in priority order: `PIM_ORG_SLUG`, the nearest repository `.pim.json`,
  then the default persisted by `set_active_org` in `~/.pim/config.json`.

Do not put an IMS access token in an ADO registry file. The sidecar should inherit the user's home
directory so the PIM MCP process can read and refresh its normal credential file.

## Build or install

For source development:

```sh
pnpm install --frozen-lockfile
pnpm --filter @pim/mcp-server build
```

The entry point is then:

```text
<pim-repo>/packages/mcp-server/dist/index.js
```

For a published installation:

```sh
npm install -g @pim/mcp-server \
  --registry=https://artifactory-uw2.adobeitc.com/artifactory/api/npm/npm-adobe-pim-release/
```

Run `npm root -g` to resolve the global package directory when ADO needs an absolute executable
path. See [PIM onboarding](../../docs/ONBOARDING.md) for Artifactory login and package setup.

## Configure the sidecar

ADO must launch the entry point with `node`, bridge its stdio transport using ADO's supported MCP
sidecar mechanism, and provide the target API URL:

```text
command: node
args: [<absolute-path>/@pim/mcp-server/dist/index.js]
environment:
  PIM_API_URL: <pim-base-url>
  PIM_ORG_SLUG: <optional-default-org>
```

Resolve the hosted URL from the deployed `CloudFrontUrl` stack output. Do not copy an ALB origin
or instance address into client configuration.

If the ADO tool registry still uses a vendor/bridge record, its conceptual configuration is:

```json
{
  "id": "pim",
  "name": "PIM",
  "status": "available",
  "vendorPath": "vendor/pim/dist/index.js",
  "sidecarMode": "bridge",
  "credentials": [
    {
      "id": "pim_api_url",
      "label": "PIM Server URL",
      "type": "url",
      "required": true
    }
  ],
  "credentialEnvMap": {
    "pim_api_url": "PIM_API_URL"
  }
}
```

Treat the field names and bridge port as ADO-owned configuration, not as a stable PIM API. Pick a
port from ADO's current sidecar allocation instead of relying on the old example port.

## Authentication and first use

The simplest preflight is:

```sh
pim login
```

An MCP client can instead drive the interactive flow:

1. Call `authenticate`.
2. If it returns an authorization URL, show it to the user and wait for sign-in.
3. Call `complete_authentication`.
4. If organization selection is required, call `list_orgs`, then `set_active_org` with the chosen
   slug.

On a later 401, repeat `authenticate`; access tokens can expire during a long session.

## Capability discovery

Do not copy a tool count into ADO. The interactive surface evolves and MCP discovery is the source
of truth. It currently includes these groups:

- authentication and organization selection;
- project profiles, resource bindings, project search, and project session context;
- pod lifecycle, session context, updates, milestones, conflicts, tunnels, and quality stats;
- organization knowledge and external context search;
- skill-catalog search, browsing, and conflict checks; and
- lint and curation workflows.

The server also publishes organization, project, pod, and knowledge resources plus reusable pod
workflow prompts. ADO should use MCP `tools/list`, `resources/list`, `resources/templates/list`,
and `prompts/list` rather than maintaining a duplicate catalog.

## Integration checks

Before declaring the sidecar ready:

1. Check `<pim-base-url>/api/health`.
2. Start the sidecar through ADO and complete authentication.
3. Confirm `tools/list` includes `authenticate`, `get_agent_session_context`, `project_search`,
   and `query_knowledge`.
4. Select an organization and run a read-only call such as `list_projects`.
5. Verify ADO does not log credential-file contents, authorization headers, or MCP request bodies
   containing sensitive context.

For local backend development, run:

```sh
pnpm --filter @pim/server dev
```

Then set `PIM_API_URL=http://localhost:4000` for the sidecar.

## Distribution

Prefer installing the published package as an ADO dependency. If ADO vendors the build instead,
copy the complete package output and install its production dependencies; copying only selected
JavaScript files can omit generated modules or package metadata. Rebuild after PIM changes and pin
the distributed package version so the bridge and its discovered capabilities are reproducible.
