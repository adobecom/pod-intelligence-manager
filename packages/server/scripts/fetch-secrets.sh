#!/bin/sh
# Fetches SSM Parameter Store values at PIM_SSM_PATH and exports them as env vars.
# Parameter name /pim/SLACK_BOT_TOKEN becomes env var SLACK_BOT_TOKEN.
# Must be sourced (not executed) so exports propagate to the caller.
#
# Limitations: parameter values containing tabs or newlines will be truncated.
# All Adobe-scoped tokens we currently use are single-line, so this is acceptable.

SSM_PATH="${PIM_SSM_PATH:-/pim/}"
REGION="${AWS_REGION:-us-west-2}"

echo "[fetch-secrets] Loading parameters from $SSM_PATH (region: $REGION)"

TMPFILE=$(mktemp)
if ! aws ssm get-parameters-by-path \
    --path "$SSM_PATH" \
    --with-decryption \
    --recursive \
    --region "$REGION" \
    --query 'Parameters[*].[Name,Value]' \
    --output text > "$TMPFILE" 2>/dev/null; then
    echo "[fetch-secrets] WARNING: failed to fetch from $SSM_PATH (continuing without them)"
    rm -f "$TMPFILE"
    return 0 2>/dev/null || exit 0
fi

COUNT=0
while IFS="$(printf '\t')" read -r NAME VALUE; do
    [ -z "$NAME" ] && continue
    VAR_NAME=$(basename "$NAME")
    export "$VAR_NAME=$VALUE"
    COUNT=$((COUNT + 1))
done < "$TMPFILE"

rm -f "$TMPFILE"
echo "[fetch-secrets] Loaded $COUNT parameter(s)"
