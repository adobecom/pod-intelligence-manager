# Project search connectors

Slack and Confluence scheduled ingestion are disabled by default. Configure and validate one project/source at a time, then enable its independent flag.

GitHub and Jira service credentials can see more than a PIM project audience. Their indexed and project-live paths are therefore restricted to the canonical repository and Jira-project bindings stored in the project's `resources_json`. Connector bindings are non-secret configuration and may only be changed by an org admin or owner; service credentials remain deployment secrets. Jira projects configured here must not use an issue-security audience narrower than the corresponding PIM project.

Local Git reads are limited to the server working directory by default. Set `PROJECT_GIT_ALLOWED_ROOTS` to a comma-separated list of additional operator-owned roots; project users cannot use `repo_paths` to read arbitrary server repositories.

## Slack

Use an internal bot token with only the scopes required for `auth.test`, `conversations.info`, `conversations.history`, and `conversations.replies`. Scheduled ingestion does not accept legacy user-token environment variables.

Configure one of the `SLACK_INGEST_BOT_TOKEN*`/`SLACK_BOT_TOKEN*` variables, bind stable public channel IDs in `resources.slack.channels` (use `workspace:C012345` when multiple workspaces are configured), then set:

```sh
PROJECT_SLACK_INGESTION_ENABLED=1
PROJECT_SLACK_SEARCH_ENABLED=0
```

Leave `PROJECT_SLACK_SEARCH_ENABLED=0` while the initial backfill and a complete reconciliation succeed. Inspect health, then set it to `1`. Private channels, DMs, group DMs, archived channels, non-member channels, malformed bindings, and empty bindings are rejected without content persistence.

## Confluence

Configure `CONFLUENCE_BASE_URL` and `CONFLUENCE_TOKEN`, plus explicit spaces/pages in the project resources. A resource binding selects content but is not a visibility proof. An operator must separately attest scopes that every PIM project searcher can view:

```sh
CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS=ENG,DOCS
CONFLUENCE_PROJECT_VISIBLE_PAGE_IDS=12345,67890
PROJECT_CONFLUENCE_INGESTION_ENABLED=1
PROJECT_CONFLUENCE_SEARCH_ENABLED=0
```

The connector still probes direct and inherited read restrictions on every scan. Missing policy, failed restriction probes, restricted ancestors, unexpected pagination URLs, and content moved outside the approved policy fail closed. Removing the policy also makes existing Confluence documents query-ineligible and purges them on the next sync.

Leave `PROJECT_CONFLUENCE_SEARCH_ENABLED=0` through the initial unrestricted-page reconciliation. Enable it only after health reports a successful complete scan under the current site, bindings, and visibility policy.

## Operations

Adding or changing a binding conservatively purges that source and schedules an immediate refresh. The normal scheduler also runs once at server startup. Inspect `GET /api/projects/:projectId/source-health` or the `source_health` field on project-search responses for attempt/success/reconciliation timestamps, channel watermarks, lag, indexed counts, retries, and generic error codes.

Before enabling a connector against an existing corpus, follow [PROJECT_SEARCH_SCRUB_RUNBOOK.md](./PROJECT_SEARCH_SCRUB_RUNBOOK.md). Do not restore an unsanitized database, WAL, cache, backup, or replica as a rollback path.
