#!/usr/bin/env bash
#
# AI Council — CLI Demo
#
# Demonstrates the full Council workflow using CLI commands.
#
# Prerequisites:
#   1. Start the server: pnpm --filter @council/server dev
#   2. Optionally start the UI: pnpm --filter @council/ui dev
#
# Usage:
#   bash examples/demo-cli.sh
#

set -e
CLI="npx tsx packages/cli/src/index.ts"
DIVIDER="════════════════════════════════════════════════════════════════"

echo ""
echo "$DIVIDER"
echo "  AI Council — CLI Demo"
echo "$DIVIDER"

echo ""
echo "── Step 1: List existing pods ──"
$CLI pod list

echo ""
echo "── Step 2: Create a new pod ──"
$CLI pod create --name "CLI Demo Sprint"

echo ""
echo "── Step 3: Check pod status ──"
$CLI pod status pod-cli-demo-sprint

echo ""
echo "── Step 4: Submit a progress update ──"
$CLI report \
  --pod pod-cli-demo-sprint \
  --type progress \
  --scope frontend \
  --agent cli-demo-agent \
  --summary "Built the homepage hero section with responsive layout" \
  --details "Hero component with animated gradient, CTA button, and feature grid below the fold." \
  --status completed

echo ""
echo "── Step 5: Submit a decision ──"
$CLI report \
  --pod pod-cli-demo-sprint \
  --type decision \
  --scope backend \
  --agent cli-demo-agent \
  --summary "Use PostgreSQL instead of MongoDB for product catalog" \
  --details "Relational model fits the product-variant-SKU hierarchy better. Existing team has strong SQL experience." \
  --status completed

echo ""
echo "── Step 6: View the living doc ──"
$CLI doc pod-cli-demo-sprint

echo ""
echo "── Step 7: Run a lint pass ──"
$CLI lint pod-cli-demo-sprint

echo ""
echo "── Step 8: Register a tunnel ──"
echo "  (Starting tunnel in background — will auto-disconnect on script exit)"
$CLI tunnel start --pod pod-cli-demo-sprint --port 3000 --dev alice --branch feat/homepage &
TUNNEL_PID=$!
sleep 2

echo ""
echo "── Step 9: List tunnels ──"
$CLI tunnel list --pod pod-cli-demo-sprint

# Clean up tunnel
kill $TUNNEL_PID 2>/dev/null || true
wait $TUNNEL_PID 2>/dev/null || true

echo ""
echo "$DIVIDER"
echo "  CLI Demo complete!"
echo "  Check the UI at http://localhost:5173 to see all changes."
echo "$DIVIDER"
echo ""
