Pull the latest PIM pod context and summarize what's relevant to your current work.

Steps:
1. Run: pim context --pod pod-emc-webhook-integration-84aa08 --scope frontend --diff
2. If no previous context exists, run without --diff: pim context --pod pod-emc-webhook-integration-84aa08 --scope frontend --brief
3. Parse the output and summarize:
   - Current pod pressure and day number
   - Any open conflicts that affect scope "frontend"
   - Recent updates from other agents that you should be aware of
   - Relevant org learnings
4. If conflict pressure >= 0.6, warn about potential merge restrictions
5. If there are open conflicts in your scope, list them and recommend reviewing before proceeding
