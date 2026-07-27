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

If the assistant asks which catalog to use, choose the source configured by your
team, such as `mimir-main`.
