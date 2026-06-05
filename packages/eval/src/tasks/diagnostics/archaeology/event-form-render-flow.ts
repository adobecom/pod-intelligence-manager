import type { Task } from "../../types.js";
import { archaeologyRubric } from "./_helper.js";

const GROUND_TRUTH = `Expected render flow from event-form page to first API call:

Entry:
- web-src/src/pages/EventForm/EventForm.tsx (route component — mounts EventFormContext, renders sections)

Mounted providers / contexts:
- web-src/src/contexts/EventFormContext.tsx (provides form state, eventId, formData, save status)
- web-src/src/contexts/GroupContext.tsx (provides current group/scope used for permission checks)

Form sections (render order):
- EventInfoComponent (basic event info: title, dates)
- EventFormatComponent (format selector — uses useGroup for gating)
- SessionManagement/Sessions.tsx and SessionForm.tsx (sessions sub-form)
- SpeakerPickerDialog.tsx and SponsorsComponent.tsx (related entities)

Save flow:
- web-src/src/hooks/useEventFormSave.ts (orchestrates the save — reads context, calls apiService)
- web-src/src/services/api.ts (apiService — issues the network PUT/POST)

First API call:
- apiService.createEvent (in create mode) or apiService.updateEvent (in edit mode)`;

export const eventFormRenderFlow: Task = {
  id: "arch-event-form-render-flow",
  type: "content",
  podId: "pod-emc-sessions",
  stratum: "S6",
  tags: ["archaeology", "flow"],
  licSeed: {
    investigateQuery: "render and save flow from EventForm page to first API call",
  },
  prompt: [
    "# Question",
    "",
    "Trace the render and save flow in the EMC web app starting from the EventForm route component. Specifically:",
    "1. What providers/contexts mount when EventForm is rendered?",
    "2. What sub-components are rendered as part of the event form?",
    "3. When the user clicks 'Save', what hook orchestrates the save?",
    "4. Which apiService function issues the first network request?",
    "",
    "# Output format",
    "",
    "A markdown structure with the four numbered sections above. Use file paths in backticks. Be specific about what each piece does in one sentence.",
  ].join("\n"),
  groundTruth: {
    output: GROUND_TRUTH,
    note: "Captured from lic investigate + find-references on useEventFormSave, EventFormContext, GroupContext.",
  },
  rubric: archaeologyRubric("arch-event-form-render-flow-v1"),
};
