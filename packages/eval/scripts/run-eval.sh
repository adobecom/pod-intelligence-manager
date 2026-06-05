#!/usr/bin/env bash
#
# Protocol driver for the PIM vs locally indexed code (LIC) eval. Pins the
# protocol-required flags (holdout, protocol, judge model, seeds) so the only knob
# the caller flips is the candidate model.
#
# "LIC" = locally indexed code: a frozen, point-in-time semantic index of the
# product source tree, used as the code-intelligence comparator arm.
#
# Usage:
#   bash packages/eval/scripts/run-eval.sh --model=sonnet            # full 3-seed Sonnet run
#   bash packages/eval/scripts/run-eval.sh --model=haiku             # full 3-seed Haiku run
#   bash packages/eval/scripts/run-eval.sh --model=sonnet --smoke    # 2-task pilot (~$0.05, ~1 min)
#   bash packages/eval/scripts/run-eval.sh --model=sonnet --seeds=1  # cheap 1-seed pass
#
# Run both in parallel by opening two terminals — one Sonnet, one Haiku.
#
# Logs land in packages/eval/runs/<runId>/run.log alongside the artifacts.

set -euo pipefail

# ── defaults ───────────────────────────────────────────────────────────────
MODEL_ARG=""
SEEDS=3
SMOKE=0

JUDGE_MODEL="us.meta.llama3-3-70b-instruct-v1:0"
HOLDOUT="holdouts/holdout-haiku-v2.json"
PROTOCOL="protocols/pim-vs-lic-haiku-v2.md"

# Registered, pre-registered arms. kg-lic is intentionally omitted: it is an
# exploratory marginal-LIC-on-KG arm, not part of the headline comparison. Append
# it with --arms=...,kg-lic only when reporting it as exploratory.
ARMS="control,pim-full,kg-only,lic-full,lic-pim-combined,length-matched-neutral,pim-clipped,lic-clipped"

# Smoke pilot uses one PIM-favorable and one LIC-favorable headline task to verify
# the harness end-to-end across both context paths.
SMOKE_TASKS="real-emc-prod-publish-confirmation,real-emc-event-put-omit-detail-page-path"
SMOKE_ARMS="control,pim-full,lic-full"

# ── arg parse ──────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --model=*)  MODEL_ARG="${arg#*=}";;
    --seeds=*)  SEEDS="${arg#*=}";;
    --smoke)    SMOKE=1;;
    -h|--help)  sed -n '3,21p' "$0"; exit 0;;
    *)          echo "Unknown flag: $arg" >&2; exit 1;;
  esac
done

if [[ -z "$MODEL_ARG" ]]; then
  echo "Missing --model=sonnet|haiku|<full-bedrock-id>" >&2
  exit 1
fi

# ── model alias resolution ─────────────────────────────────────────────────
case "$MODEL_ARG" in
  sonnet)  CANDIDATE_MODEL="us.anthropic.claude-sonnet-4-6";;
  haiku)   CANDIDATE_MODEL="us.anthropic.claude-haiku-4-5-20251001-v1:0";;
  opus)    CANDIDATE_MODEL="us.anthropic.claude-opus-4-7";;
  *)       CANDIDATE_MODEL="$MODEL_ARG";;
esac

# ── locate package root ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_ROOT"

# ── invocation ─────────────────────────────────────────────────────────────
# Use a portable date format (BSD date on macOS has no %N support); the seconds
# resolution is fine because we never start two runs of the same model in the
# same second.
RUN_ID="$(date -u +%Y-%m-%dT%H-%M-%SZ)"

# Build RUN_DIR with explicit if/else because $([[ test ]] && echo) inside a
# command substitution silently exits the parent under set -e on bash 3.2 (macOS).
if [[ $SMOKE -eq 1 ]]; then
  RUN_DIR="runs/${RUN_ID}__${MODEL_ARG}__smoke"
  SMOKE_LABEL="yes"
else
  RUN_DIR="runs/${RUN_ID}__${MODEL_ARG}"
  SMOKE_LABEL="no"
fi
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/run.log"

echo "===========================================================" | tee -a "$LOG"
echo " PIM vs locally indexed code (LIC) eval run" | tee -a "$LOG"
echo "   candidate model: $CANDIDATE_MODEL" | tee -a "$LOG"
echo "   judge model:     $JUDGE_MODEL" | tee -a "$LOG"
echo "   seeds:           $SEEDS" | tee -a "$LOG"
echo "   smoke:           $SMOKE_LABEL" | tee -a "$LOG"
echo "   run dir:         $RUN_DIR" | tee -a "$LOG"
echo "==========================================================="  | tee -a "$LOG"

if [[ $SMOKE -eq 1 ]]; then
  CMD=(
    node --import tsx src/cli/run.ts
    --model="$CANDIDATE_MODEL"
    --judge-model="$JUDGE_MODEL"
    --tasks="$SMOKE_TASKS"
    --arms="$SMOKE_ARMS"
    --seeds=1
    --report="$RUN_DIR/report.md"
  )
else
  CMD=(
    node --import tsx src/cli/run.ts
    --model="$CANDIDATE_MODEL"
    --judge-model="$JUDGE_MODEL"
    --holdout="$HOLDOUT"
    --protocol="$PROTOCOL"
    --seeds="$SEEDS"
    --run-dir="$RUN_DIR"
    --arms="$ARMS"
  )
fi

# Tee stdout+stderr so the user sees streaming progress AND the run.log captures it.
"${CMD[@]}" 2>&1 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "Done. Report: $RUN_DIR/report.md" | tee -a "$LOG"
echo "Next: analyze + audit the run:" | tee -a "$LOG"
echo "  pnpm --filter @pim/eval analyze-run -- --run-dir=$RUN_DIR" | tee -a "$LOG"
echo "  pnpm --filter @pim/eval audit-run -- --type=temporal --run-dir=$RUN_DIR" | tee -a "$LOG"
echo "  pnpm --filter @pim/eval audit-run -- --type=judging  --run-dir=$RUN_DIR" | tee -a "$LOG"
