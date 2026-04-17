/**
 * Seeds the knowledge graph with realistic mock learnings from the two
 * archived pods (Onboarding Flow v2, Notification System) so the
 * /knowledge UI has data to display out of the box.
 */

import type { EnhancedPodLearning } from "@pim/shared";
import { getGraph, addLearningsToGraph } from "../services/knowledge-graph.js";

// --- Onboarding Flow v2 (pod-onboarding-v2, completed 2026-03-28) ---

const onboardingLearnings: EnhancedPodLearning[] = [
  {
    type: "decision",
    summary: "Use progressive disclosure for onboarding steps instead of a single long form",
    details:
      "Decision by design-lead: Multi-step wizard with progress indicator outperformed single-page form in internal usability testing. Each step validates independently before proceeding. Reduces perceived complexity for new users.",
    domains: ["frontend", "design"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "decision",
    summary: "Store onboarding progress server-side so users can resume across devices",
    details:
      "Decision by be-agent-05: Onboarding state persisted in DynamoDB with TTL of 30 days. Keyed by user_id. Enables resume-on-any-device and prevents data loss on browser crash.",
    domains: ["backend", "infra"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary: "Skeleton screens during API calls improve perceived performance on onboarding pages",
    details:
      "Implemented by fe-agent-05: Replaced spinner with skeleton placeholders for the org-setup and team-invite steps. User feedback was significantly more positive. Skeleton components are reusable across other flows.",
    domains: ["frontend", "design"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "resolved_conflict",
    summary: "Email verification: blocking gate vs. soft reminder — resolved: blocking gate with grace period",
    details:
      "Conflict between pm-lead (wanted non-blocking to reduce drop-off) and infra-agent-03 (required verified email for SSO downstream). Resolution: blocking gate but users get a 24-hour grace period to explore the product before verification is enforced.",
    domains: ["backend", "pm"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "anti_pattern",
    summary: "Loading the full team directory on the invite step caused 3s delay for large orgs",
    details:
      "Reported by qa-agent-04: The team-invite step fetched the entire org directory upfront (up to 10k users). This caused a 3-second blocking load on the invite step. Fixed by switching to typeahead search with debounced API calls.",
    domains: ["frontend", "backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "scope_insight",
    summary: "Onboarding completion rate correlates strongly with first-value-moment speed",
    details:
      "Analysis by pm-lead: Users who reached their first meaningful action (creating a project or inviting a teammate) within 2 minutes of signup had 4x higher 30-day retention. Onboarding should optimize for time-to-first-value above all else.",
    domains: ["pm", "design"],
    confidence: "inferred",
    confidence_score: 0.75,
  },
  {
    type: "pattern",
    summary: "Feature flags on onboarding steps allow A/B testing without redeployment",
    details:
      "Implemented by infra-agent-03: Each onboarding step wrapped in a LaunchDarkly flag. Enabled rapid iteration on step order and content without code deploys. Recommend this pattern for any user-facing wizard.",
    domains: ["infra", "frontend"],
    confidence: "inferred",
    confidence_score: 0.7,
  },
  {
    type: "decision",
    summary: "Use Adobe IMS tokens directly instead of minting separate onboarding session tokens",
    details:
      "Decision by be-agent-05: Eliminated a redundant token layer. Onboarding API validates the existing IMS access token directly. Reduces auth complexity and avoids token-refresh edge cases during multi-step flows.",
    domains: ["backend", "infra"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
];

// --- Notification System (pod-notifications, completed 2026-03-21) ---

const notificationLearnings: EnhancedPodLearning[] = [
  {
    type: "decision",
    summary: "Fan-out via SNS+SQS instead of direct Lambda invocation for notification delivery",
    details:
      "Decision by infra-agent-04: SNS topic fans out to per-channel SQS queues (email, Slack, in-app). Each channel has its own consumer Lambda. Decouples channel logic, allows independent scaling and retry policies per channel.",
    domains: ["infra", "backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "decision",
    summary: "Notification preferences stored per-user with channel-level granularity",
    details:
      "Decision by be-agent-06: Users can opt in/out per channel (email, Slack, in-app) and per notification category (mentions, assignments, system alerts). Stored in DynamoDB with GSI on user_id. Default: all channels enabled.",
    domains: ["backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary: "Exponential backoff with jitter on notification delivery retries prevents thundering herd",
    details:
      "Implemented by infra-agent-04: SQS consumers use exponential backoff (base 2s, max 5min) with random jitter (0-500ms). After 5 retries, messages go to DLQ for manual inspection. Prevents cascading failures when Slack or email APIs are degraded.",
    domains: ["infra", "backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "resolved_conflict",
    summary: "In-app notification badge: real-time WebSocket vs. polling — resolved: WebSocket with polling fallback",
    details:
      "Conflict between fe-agent-06 (preferred polling for simplicity) and be-agent-06 (wanted WebSocket for real-time UX). Resolution: primary delivery via WebSocket push, with 30-second polling fallback for clients that lose WS connection. Badge count endpoint is cheap (single DynamoDB query).",
    domains: ["frontend", "backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "anti_pattern",
    summary: "Sending notification emails synchronously in the request path caused 2s API latency spikes",
    details:
      "Reported by qa-agent-05: Initial implementation called SES directly in the API handler. Under load, SES throttling caused P99 latency to spike to 2s. Fixed by moving to async SNS publish (P99 dropped to 50ms).",
    domains: ["backend", "infra"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary: "Idempotency keys on notification sends prevent duplicate delivery during retries",
    details:
      "Implemented by be-agent-06: Each notification gets a deterministic idempotency key (hash of user_id + event_type + entity_id + timestamp_bucket). Consumers check DynamoDB before sending. Eliminated duplicate emails during SQS retry storms.",
    domains: ["backend"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "scope_insight",
    summary: "Slack notifications have 3x higher engagement than email for time-sensitive alerts",
    details:
      "Analysis by pm-lead: Tracking data showed Slack notifications for mentions and assignment changes had a 68% click-through rate vs. 22% for email. Recommend defaulting to Slack for action-required notifications and email for digests.",
    domains: ["pm"],
    confidence: "inferred",
    confidence_score: 0.65,
  },
  {
    type: "anti_pattern",
    summary: "Rendering notification templates at send-time caused Lambda cold start timeouts",
    details:
      "Reported by infra-agent-04: Handlebars template compilation on cold Lambda starts added 800ms. Fixed by pre-compiling templates at build time and bundling compiled output. Cold start dropped to under 200ms.",
    domains: ["infra", "backend"],
    confidence: "inferred",
    confidence_score: 0.7,
  },
  {
    type: "decision",
    summary: "Use DynamoDB TTL to auto-expire read in-app notifications after 90 days",
    details:
      "Decision by be-agent-06: In-app notifications marked as read get a TTL of 90 days. Unread notifications persist indefinitely. Keeps the notifications table lean without manual cleanup jobs.",
    domains: ["backend", "infra"],
    confidence: "extracted",
    confidence_score: 0.9,
  },
  {
    type: "pattern",
    summary: "Notification content should be self-contained — never require a second API call to render",
    details:
      "Implemented by fe-agent-06: Each notification payload includes all display-ready data (actor name, action verb, entity title, deep link URL). The frontend renders directly from the payload without fetching additional context. Improves render speed and reduces API load.",
    domains: ["frontend", "backend"],
    confidence: "inferred",
    confidence_score: 0.75,
  },
];

export function seedKnowledgeGraph(): void {
  const graph = getGraph();
  if (graph.nodes.length > 0) return; // Already seeded

  console.log("[knowledge-graph] Seeding mock knowledge from archived pods...");

  const result1 = addLearningsToGraph(
    onboardingLearnings,
    "pod-onboarding-v2",
    "Onboarding Flow v2",
  );
  console.log(
    `[knowledge-graph] Onboarding Flow v2: ${result1.nodesAdded} nodes, ${result1.edgesAdded} edges`,
  );

  const result2 = addLearningsToGraph(
    notificationLearnings,
    "pod-notifications",
    "Notification System",
  );
  console.log(
    `[knowledge-graph] Notification System: ${result2.nodesAdded} nodes, ${result2.edgesAdded} edges`,
  );

  console.log(
    `[knowledge-graph] Seeding complete: ${graph.nodes.length} total nodes, ${graph.edges.length} total edges, ${graph.communities.length} communities`,
  );
}
