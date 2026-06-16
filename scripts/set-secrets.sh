#!/usr/bin/env bash
#
# Securely (re)set PIM access tokens in .env.
#
# Tokens are read with `read -s` (no echo), never passed as command arguments,
# and never written to shell history. Run this in YOUR OWN terminal — not via
# the Claude Code `!` prefix — so the values are not captured in the transcript:
#
#   bash scripts/set-secrets.sh
#
# Press Enter on a blank prompt to leave that token unchanged. The .env file is
# gitignored. Existing line positions/comments are preserved.
#
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=".env"
[ -f "$ENV_FILE" ] || { echo "No .env at $(pwd)/$ENV_FILE — copy .env.example first." >&2; exit 1; }

# Upsert KEY=VALUE in-place, preserving order and handling arbitrary characters
# (value passed via the environment, never via argv or sed escaping).
upsert() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  VAL="$val" awk -v key="$key" '
    BEGIN { FS = OFS = "=" }
    $1 == key && !done { print key "=" ENVIRON["VAL"]; done = 1; next }
    { print }
    END { if (!done) print key "=" ENVIRON["VAL"] }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

prompt_token() {
  local label="$1" val
  printf '%s (blank = keep current): ' "$label" >&2
  read -rs val; printf '\n' >&2
  printf '%s' "$val"
}

echo "Updating tokens in $(pwd)/$ENV_FILE" >&2
echo >&2

gh="$(prompt_token 'GitHub (github.com) PAT  [GH_TOKEN + GITHUB_TOKEN]')"
if [ -n "$gh" ]; then
  upsert GH_TOKEN "$gh"
  upsert GITHUB_TOKEN "$gh"
  echo "  ✓ GH_TOKEN + GITHUB_TOKEN updated" >&2
else echo "  · GitHub unchanged" >&2; fi
unset gh

corp="$(prompt_token 'git.corp.adobe.com PAT   [GITCORP_TOKEN]')"
if [ -n "$corp" ]; then upsert GITCORP_TOKEN "$corp"; echo "  ✓ GITCORP_TOKEN updated" >&2; else echo "  · gitcorp unchanged" >&2; fi
unset corp

jira="$(prompt_token 'Jira (jira.corp.adobe.com) PAT [JIRA_TOKEN]')"
if [ -n "$jira" ]; then upsert JIRA_TOKEN "$jira"; echo "  ✓ JIRA_TOKEN updated" >&2; else echo "  · Jira unchanged" >&2; fi
unset jira

echo >&2
echo "Done. Next: validate with — npm --prefix packages/server run seed-project-search -- project-emc (or ask the agent to run the masked health probe)." >&2
