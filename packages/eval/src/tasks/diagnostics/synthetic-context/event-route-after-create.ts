import type { Task } from "../../types.js";

export const synthEventRouteAfterCreate: Task = {
  id: "synth-event-route-after-create",
  type: "code",
  podId: "pod-emc-sessions",
  stratum: "S2",
  tags: ["synthetic", "context-stress", "lic-needed", "event-form", "routing"],
  prompt: [
    "Implement `nextEventRouteAfterSave(result: Record<string, any>, isEditMode: boolean): null | { path: string; replace: boolean }`.",
    "",
    "The EventForm save handler should decide whether the router needs to move after a successful save. Follow the existing EventForm routing pattern; do not invent a new URL shape.",
    "",
    "Export the function as a named export `nextEventRouteAfterSave`.",
  ].join("\n"),
  expectedSignals: ["/events/edit/", "replace", "eventId", "isEditMode"],
  tests: [
    {
      name: "routes newly-created events to the edit URL using replace",
      body: [
        "assert.deepEqual(mod.nextEventRouteAfterSave({ success: true, eventId: 'evt-123' }, false), { path: '/events/edit/evt-123', replace: true });",
      ].join("\n"),
    },
    {
      name: "does not route when editing an existing event",
      body: [
        "assert.equal(mod.nextEventRouteAfterSave({ success: true, eventId: 'evt-123' }, true), null);",
      ].join("\n"),
    },
    {
      name: "does not route on failed or incomplete saves",
      body: [
        "assert.equal(mod.nextEventRouteAfterSave({ success: false, eventId: 'evt-123' }, false), null);",
        "assert.equal(mod.nextEventRouteAfterSave({ success: true }, false), null);",
      ].join("\n"),
    },
  ],
};
