# PIM documentation

This index covers maintained operational guidance for the implemented system. When documents
disagree, use the current code, generated contracts, tests, and the documents in **Current system**
as the source of truth.

## Start here

| Document | Purpose |
| --- | --- |
| [Repository README](../README.md) | Setup, packages, commands, and product overview |
| [Onboarding](./ONBOARDING.md) | Install the CLI/MCP packages and connect a repository |
| [Contributing](../.github/CONTRIBUTING.md) | Branch, test, and pull-request conventions |
| [Architecture overview](./ARCHITECTURE_OVERVIEW.md) | Implemented runtime and deployment architecture |

## Current system

| Area | Documents |
| --- | --- |
| Pod coordination | [Pod agent protocol](./POD_AGENT_PROTOCOL.md) |
| Context and project search | [Context search](./CONTEXT_SEARCH.md), [connector configuration](./PROJECT_SEARCH_CONNECTORS.md), [corpus scrub](./PROJECT_SEARCH_SCRUB_RUNBOOK.md) |
| Skill catalog | [Skill catalog user guide](./SKILL_CATALOG_USER_GUIDE.md) |
| Interactive MCP clients | [ADO sidecar integration](../packages/mcp-server/ADO_INTEGRATION.md) |
| Canonical memory | [API and MCP surface](./MEMORY_API.md), [operations](./MEMORY_OPERATIONS.md), [private MCP service-token profile](./MCP_A_PRIVATE_PIM_SERVICE_TOKEN_PROFILE.md), [retention and erasure](./MEMORY_RETENTION_ERASURE.md), [backup and restore](./BACKUP_RESTORE.md) |
| Deployment | [AWS deployment](./DEPLOY.md), [manual agent deploy](./AGENT_MANUAL_DEPLOY.md), [EDR/Splunk runbook](./EDR_INSTALL_RUNBOOK.md) |
| Package publishing | [npm and Artifactory](./NPM_ARTIFACTORY.md) |

## Local research

Long-form research, one-off handoffs, and external-system review notes belong in the ignored
`docs/research/` directory. They are useful working material, but they are not maintained product
documentation and must not be linked from current guides.

## Documentation maintenance

- Put current setup and common workflows in `README.md` or a focused current guide.
- Keep generated contract details in schemas and link to them instead of copying large payloads.
- Move completed or superseded plans out of the tracked tree instead of treating them as current
  documentation.
- Remove commands for deleted scripts and endpoints from active runbooks.
- Keep exploratory research and one-time handoffs under ignored `docs/research/`, not in Git.
- Run `pnpm docs:check` to validate local links and documented `pnpm` scripts.
