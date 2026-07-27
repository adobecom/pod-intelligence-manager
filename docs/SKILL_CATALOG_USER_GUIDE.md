# Skill Catalog and Conflict Check

## What this feature does

A skill is a reusable set of instructions that helps an AI perform a task.

The new Skill Catalog keeps an organized list of the skills that already exist
in a configured repository. It helps you:

1. Find an existing skill before creating another one.
2. Check a completed skill for definite duplicates.
3. Catch duplicate skill changes during pull-request review.

The main goal is simple: reuse useful work and avoid maintaining multiple skills
that do the same thing.

## How to use it

You can use the feature through a connected AI assistant. You do not need to
call an API or prepare technical data yourself.

### 1. Look through the catalog

Ask the assistant to show the available skills when you want to understand what
the team already has.

For example:

> Show me the shared skills in our skill catalog.

The assistant can browse the full catalog or narrow it to shared skills or a
specific project.

### 2. Search before creating a skill

Describe what you want the new skill to do before asking the assistant to write
it.

For example:

> Before creating a skill that reviews pull requests for security problems,
> search the skill catalog for anything similar.

The search normally returns a short list of skills worth reading, including
their location and a short excerpt.

These results are suggestions, not a final decision. A result may be related
without being a duplicate. An empty result also does not guarantee that no
duplicate exists.

After reviewing the suggestions, you can:

- Reuse an existing skill.
- Adjust your idea so it has a different purpose.
- Continue creating the new skill if it is genuinely needed.

### 3. Check the finished skill

Once the final draft is ready, ask the assistant to run the conflict check
before submitting it.

For example:

> Run the final skill conflict check on this completed draft before opening the
> pull request.

This check compares the complete draft with the catalog at the exact version of
the repository your work is based on.

## Understanding the result

| Result | What it means | What to do |
| --- | --- | --- |
| **Clear** | No definite duplicate was found by the exact checks. | Review any related suggestions, then continue. |
| **Conflict found** | The draft definitely matches an existing skill or another new draft. | Open the listed match and reuse, rename, move, or revise your draft. Then run the check again. |
| **Related skills** | The system found skills with a similar purpose. This is advice, not a blocking result. | Read them and decide whether reuse would be better. |
| **Catalog building** | The requested repository version is still being prepared. | Wait briefly and retry with the same draft. |
| **Unavailable** | The system could not produce a reliable answer. | Retry later. Do not treat this as a clear result. |

A definite conflict means at least one of these is true:

- The same file location is already used.
- The same skill name already exists in the same project or shared area.
- The underlying skill content is the same.
- Two skills being submitted together duplicate each other in one of those
  ways.

A similar purpose by itself is never treated as a definite conflict.

## What happens in a pull request

When the repository's pull-request check is enabled, it automatically reviews
added, modified, and renamed skill files. It leaves one updated comment showing
any definite conflicts and useful related skills.

The check can run in either of these modes:

- **Advisory mode:** it reports problems but does not stop the pull request.
- **Required mode:** a definite conflict blocks the pull request until it is
  resolved. If the system cannot produce a reliable result, the check keeps the
  pull request blocked rather than incorrectly reporting success.

Related-skill suggestions never block a pull request.

## How it works behind the scenes

1. PIM, the service behind this feature, reads the configured skill repository
   and builds a catalog of skill names, locations, project or shared ownership,
   descriptions, and content.
2. GitHub updates and a regular background check keep the catalog current.
3. The early search looks for skills with a similar meaning and returns the most
   useful ones to review.
4. The final check uses exact rules against a specific repository version, so
   its result is repeatable and does not change midway through a review.
5. The pull-request check repeats the final validation as a safety net for
   manual edits or skipped earlier checks.

Searchable text is redacted for secrets, and submitted draft bodies are excluded
from request logging.

## Good habit to remember

Use this simple sequence whenever you create a skill:

> Search first, create only if needed, run the final check, then open the pull
> request.

For normal project work, the assistant should not need to ask which catalog to
use. PIM resolves an explicit advanced override first, then the project's
catalog mapping, then the organization default. It returns
`skill_catalog_source_not_configured` instead of guessing when neither mapping
exists.

Any human organization member can choose the org default on the Organization
Dashboard and a project override on the Project Dashboard. Service tokens
cannot change these mappings. The selectors use sanitized source metadata and
show the repository, sync state, and latest indexed commit. Source creation and
bundle import remain in the administrative workflow.

MCP project context resolves in this order: explicit `project_id`,
`PIM_PROJECT_ID`, then `.pim.json.projectId`. Normal `search_skills` and
`check_skill_conflicts` calls can omit `source_id`; conflict checks can also
omit `base_commit_sha` to use the selected source's newest ready default-branch
snapshot. Mimir pull-request checks, CI, and replay should continue to send
their explicit source and exact base SHA.

## Building an IP-restricted catalog locally

If the hosted PIM cannot reach the repository because of an IP allowlist, build
the catalog on a machine that can reach it and upload the derived index. The
hosted service does not need repository access for the imported commit.

The destination source must already be configured in PIM with the same source
ID, repository, default ref, layout rules, and exclusions as the local build.
Configure it with `enabled: false` when hosted polling cannot reach the
repository. Disabled sources still accept admin imports and serve imported
search/conflict snapshots; the background GitHub poller skips them.
For Mimir, the defaults are:

- source ID: `mimir-main`
- repository: `Adobe-acom/mimir`
- ref: `main`
- project skills: `projects/*/skills/**/*.md`
- shared skills: `shared/skills/**/*.md`

Build the portable bundle from the repository API on the local machine:

```bash
npm --prefix packages/server run skill-catalog:bundle -- \
  --credential-alias MIMIR_GITHUB_TOKEN \
  --embed
```

`--embed` makes both semantic skill search and related-skill suggestions
available. Omit it when only deterministic path/name/content conflict checks are
needed. The default output is:

```text
.data/exports/mimir-main.skill-catalog.json
```

Upload it after the version containing the import route is deployed:

```bash
npm --prefix packages/server run skill-catalog:upload -- \
  .data/exports/mimir-main.skill-catalog.json \
  --base-url https://your-pim-host \
  --org your-org-slug \
  --create-source
```

The uploader uses `PIM_SERVICE_TOKEN`, then `PIM_ACCESS_TOKEN`, then the
refreshable IMS login written by `pim login`. A service token needs the
org-wide `skill-catalog:admin` scope; a human login needs the admin or owner
role. `--create-source` creates the source as disabled if it does not exist, so
the hosted background worker will not poll the IP-blocked repository. Omit that
flag when the destination source is already configured.

The bundle is commit-pinned and integrity-checked. It contains catalog paths,
namespaces, normalized names, content hashes, secret-redacted retrieval text,
and optional embeddings. It does not contain the GitHub credential or
unredacted skill Markdown. PIM rejects a bundle if its repository identity,
layout, matcher version, vector dimensions, or digest does not match.

For exact pull-request checks, the requested `base_commit_sha` must be one of
the imported snapshots. Rebuild and upload a new bundle when Mimir's target
commit changes; the imported snapshot remains usable even while the hosted
instance cannot reach GitHub.
