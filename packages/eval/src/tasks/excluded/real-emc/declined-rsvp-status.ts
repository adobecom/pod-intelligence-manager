import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #128 — "feat: add declined RSVP status"
 *   Parent:  18666bc0f9ec6c51b2185e317d33483bafd42e0c
 *   Merge:   d40a0dd7f03077b23f69c719153329f711977975
 *
 * Why this PR was chosen as a "saturated" sanity check:
 *   - The PR body lists every change as bullets: extend RegistrationStatus
 *     union with 'declined', add `declined` to AttendeeStats, query a third
 *     `?type=declined` in `getAllEventAttendees`, and add a "Declined" entry
 *     in StatusBadge with the `negative` variant.
 *   - Both arms should pass — this verifies PIM doesn't regress trivially
 *     self-specifying multi-file feature additions.
 */

const SOURCE_FILE = `// web-src/src/types/attendee.ts — relevant excerpts at parent 18666bc

/**
 * Registration status enum (from OpenAPI RegistrationStatus)
 *
 * Note: The GET attendees list endpoint does NOT return registrationStatus
 * on each attendee. It is only available as a query filter (\`?type=registered\`
 * or \`?type=waitlisted\`). The frontend hydrates this field at runtime by
 * querying both types and merging the results.
 */
export type RegistrationStatus = 'registered' | 'waitlisted'

export interface AttendeeStats {
  total: number
  registered: number
  waitlisted: number
  checkedIn: number
}

export function mapRegistrationStatusToDisplay(
  attendee: Attendee
): 'pending' | 'confirmed' | 'attended' | 'cancelled' {
  if (attendee.checkedIn) return 'attended'
  switch (attendee.registrationStatus) {
    case 'registered': return 'confirmed'
    case 'waitlisted': return 'pending'
    default: return 'pending'
  }
}

export function calculateAttendeeStats(attendees: Attendee[]): AttendeeStats {
  return {
    total: attendees.length,
    registered: attendees.filter(a => a.registrationStatus === 'registered' || !a.registrationStatus).length,
    waitlisted: attendees.filter(a => a.registrationStatus === 'waitlisted').length,
    checkedIn: attendees.filter(a => a.checkedIn === true).length,
  }
}

// web-src/src/components/shared/StatusBadge.tsx — relevant excerpts
const statusMap: Record<string, StatusConfig> = {
  // Series/Event/Session statuses
  draft:     { variant: 'neutral',     label: 'Draft' },
  active:    { variant: 'positive',    label: 'Active' },
  // ...other statuses...
  cancelled: { variant: 'negative',    label: 'Cancelled' },

  // Registration statuses
  confirmed: { variant: 'positive',    label: 'Confirmed' },
  pending:   { variant: 'notice',      label: 'Pending' },
  attended:  { variant: 'neutral',     label: 'Attended' },
}

// web-src/src/services/api.ts — getAllEventAttendees (only two types today)
async getAllEventAttendees(eventId: string): Promise<any[] | ErrorResponse> {
  validateString(eventId, 'event ID')
  const fetchByType = async (type: 'registered' | 'waitlisted'): Promise<any[] | ErrorResponse> => {
    const result = await this.fetchAllPages<any>({
      service: 'esp',
      baseEndpoint: \`/v1/events/\${eventId}/attendees\`,
      listKey: 'attendees',
      baseParams: { type },
      operationName: \`getAllEventAttendees (type=\${type})\`,
    })
    if ('error' in result) return result
    return result.map((attendee: any) => ({ ...attendee, registrationStatus: type }))
  }
  const [registered, waitlisted] = await Promise.all([
    fetchByType('registered'),
    fetchByType('waitlisted'),
  ])
  if ('error' in registered && 'error' in waitlisted) return registered
  const registeredList = 'error' in registered ? [] : registered
  const waitlistedList = 'error' in waitlisted ? [] : waitlisted
  return registeredList.concat(waitlistedList)
}

// web-src/src/pages/Registrations/EventInfoComponent.tsx — relevant stats row
<StatItem label="RSVPs"      value={stats.total.toString()} subtext={...} />
<StatItem label="Registered" value={stats.registered.toString()} variant="secondary" />
<StatItem label="Waitlisted" value={stats.waitlisted.toString()} variant="secondary" />
<StatItem label="Checked In" value={stats.checkedIn.toString()} variant="secondary" />
`;

const ISSUE_TEXT = `feat: add declined RSVP status

Summary
- Adds 'declined' to the RegistrationStatus type union and AttendeeStats interface
- Queries ?type=declined as a third parallel API call in getAllEventAttendees(),
  merging results alongside registered and waitlisted
- Adds "Declined" entry to StatusBadge with negative variant
- Displays declined count in the EventInfo stats panel (between Waitlisted and Checked In)

Filters, CSV export, and table rendering are data-driven and require no changes.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/types/attendee.ts
+++ b/web-src/src/types/attendee.ts
@@ -11,11 +11,11 @@
- * or \`?type=waitlisted\`). The frontend hydrates this field at runtime by
- * querying both types and merging the results.
+ * \`?type=waitlisted\`, or \`?type=declined\`). The frontend hydrates this field
+ * at runtime by querying all three types and merging the results.
  */
-export type RegistrationStatus = 'registered' | 'waitlisted'
+export type RegistrationStatus = 'registered' | 'waitlisted' | 'declined'
@@ -146,6 +146,7 @@ export interface AttendeeStats {
   total: number
   registered: number
   waitlisted: number
+  declined: number
   checkedIn: number
 }
@@ -154,16 +155,18 @@ export interface AttendeeStats {
 export function mapRegistrationStatusToDisplay(
   attendee: Attendee
-): 'pending' | 'confirmed' | 'attended' | 'cancelled' {
+): 'pending' | 'confirmed' | 'attended' | 'cancelled' | 'declined' {
   if (attendee.checkedIn) return 'attended'
   switch (attendee.registrationStatus) {
     case 'registered': return 'confirmed'
     case 'waitlisted': return 'pending'
+    case 'declined':   return 'declined'
     default: return 'pending'
   }
 }
@@ -172,13 +175,14 @@ export function calculateAttendeeStats(attendees: Attendee[]): AttendeeStats {
   return {
     total: attendees.length,
     registered: attendees.filter(a => a.registrationStatus === 'registered' || !a.registrationStatus).length,
     waitlisted: attendees.filter(a => a.registrationStatus === 'waitlisted').length,
+    declined: attendees.filter(a => a.registrationStatus === 'declined').length,
     checkedIn: attendees.filter(a => a.checkedIn === true).length,
   }
 }
--- a/web-src/src/components/shared/StatusBadge.tsx
+++ b/web-src/src/components/shared/StatusBadge.tsx
@@ -31,6 +31,7 @@ const statusMap: Record<string, StatusConfig> = {
   confirmed: { variant: 'positive',    label: 'Confirmed' },
   pending:   { variant: 'notice',      label: 'Pending' },
   attended:  { variant: 'neutral',     label: 'Attended' },
+  declined:  { variant: 'negative',    label: 'Declined' },
 }
--- a/web-src/src/services/api.ts
+++ b/web-src/src/services/api.ts
@@ -1669,13 +1669,13 @@ class ApiService {
-    const fetchByType = async (type: 'registered' | 'waitlisted'): Promise<any[] | ErrorResponse> => {
+    const fetchByType = async (type: 'registered' | 'waitlisted' | 'declined'): Promise<any[] | ErrorResponse> => {
       // ...fetchAllPages + map { ...attendee, registrationStatus: type }...
     }
-    const [registered, waitlisted] = await Promise.all([
-      fetchByType('registered'),
-      fetchByType('waitlisted'),
-    ])
-    if ('error' in registered && 'error' in waitlisted) return registered
+    const [registered, waitlisted, declined] = await Promise.all([
+      fetchByType('registered'),
+      fetchByType('waitlisted'),
+      fetchByType('declined'),
+    ])
+    if ('error' in registered && 'error' in waitlisted && 'error' in declined) return registered
     const registeredList = 'error' in registered ? [] : registered
     const waitlistedList = 'error' in waitlisted ? [] : waitlisted
-    return registeredList.concat(waitlistedList)
+    const declinedList   = 'error' in declined   ? [] : declined
+    return registeredList.concat(waitlistedList).concat(declinedList)
   }
--- a/web-src/src/pages/Registrations/EventInfoComponent.tsx
+++ b/web-src/src/pages/Registrations/EventInfoComponent.tsx
@@ -178,6 +178,11 @@ export const EventInfoComponent
             <StatItem label="Waitlisted" value={stats.waitlisted.toString()} variant="secondary" />
+            <StatItem label="Declined"   value={stats.declined.toString()}   variant="secondary" />
             <StatItem label="Checked In" value={stats.checkedIn.toString()} variant="secondary" />
`;

export const declinedRsvpStatus: Task = {
  id: "real-emc-declined-rsvp-status",
  type: "content",
  // pod-emc-configs owns RSVP / attendee data shape and StatusBadge in the EMC eval fixtures.
  podId: "pod-emc-configs",
  tags: ["real-emc", "saturated", "rsvp", "api", "types"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (parent commit 18666bc — relevant excerpts across 4 files)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) covering the four files (`types/attendee.ts`, `components/shared/StatusBadge.tsx`, `services/api.ts`, `pages/Registrations/EventInfoComponent.tsx`) that adds the `declined` RSVP status end-to-end. No prose, no full-file rewrites.",
  ].join("\n"),
  expectedSignals: ["declined", "Declined", "RegistrationStatus", "type=declined"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #128, merge SHA d40a0dd. Parent files at 18666bc.",
  },
  rubric: {
    id: "real-emc-declined-rsvp-status-v1",
    criteria: [
      {
        id: "extends_status_union",
        description:
          "Does `RegistrationStatus` (or the equivalent attendee-status union) gain the literal `'declined'`? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "extends_stats_interface",
        description:
          "Does `AttendeeStats` add a `declined` count field (and is `calculateAttendeeStats` updated to populate it)? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "queries_declined_api",
        description:
          "Does `getAllEventAttendees` issue a parallel `?type=declined` request alongside `registered` and `waitlisted`, then merge results into the returned list (including the all-errored guard)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "adds_declined_badge",
        description:
          "Does `StatusBadge`'s `statusMap` get a `declined` entry with `variant: 'negative'` and label `'Declined'`? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same end-to-end behavior (type, stats, API, badge, stat-row entry) regardless of formatting? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "valid_unified_diff",
        description:
          "Is the output a parseable unified diff with --- / +++ / @@ headers and proper +/- prefixes (not prose, not a full-file rewrite)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
