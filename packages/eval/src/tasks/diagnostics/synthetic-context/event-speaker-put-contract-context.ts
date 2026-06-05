import type { Task } from "../../types.js";

export const synthEventSpeakerPutContractContext: Task = {
  id: "synth-event-speaker-put-contract-context",
  type: "code",
  podId: "pod-emc-sessions",
  stratum: "S3",
  tags: ["synthetic", "context-stress", "pim-needed", "api", "esp"],
  prompt: [
    "Implement `buildEventSpeakerPutPayload(body: Record<string, any>, dependentData: Record<string, any>): Record<string, any>`.",
    "",
    "This helper builds the body for updating an event speaker after `getEventSpeaker` has loaded the current server copy.",
    "A recent regression came from echoing too much of the GET response back into the PUT body. Follow the already-approved EMC event-speaker PUT convention rather than inventing a broad merge.",
    "",
    "Export the function as a named export `buildEventSpeakerPutPayload`.",
  ].join("\n"),
  expectedSignals: ["speakerId", "speakerType", "ordinal", "creationTime", "modificationTime"],
  tests: [
    {
      name: "narrows to the approved event-speaker PUT contract and falls back per field",
      body: [
        "const body = { speakerId: 's-2', ordinal: 4, imageUrl: 'drop-me', creationTime: 999, modificationTime: 999 };",
        "const dependentData = { speakerId: 's-1', speakerType: 'GuestSpeaker', ordinal: 1, creationTime: 111, modificationTime: 222, createdBy: 'ada', photo: { imageId: 'img-1' } };",
        "const out = mod.buildEventSpeakerPutPayload(body, dependentData);",
        "assert.deepEqual(out, { speakerId: 's-2', speakerType: 'GuestSpeaker', ordinal: 4, creationTime: 111, modificationTime: 222 });",
      ].join("\n"),
    },
    {
      name: "server-issued timestamps always come from dependentData",
      body: [
        "const out = mod.buildEventSpeakerPutPayload({ speakerType: 'Host', creationTime: 10, modificationTime: 20 }, { speakerId: 's-1', speakerType: 'Speaker', ordinal: 3, creationTime: 111, modificationTime: 222 });",
        "assert.equal(out.creationTime, 111);",
        "assert.equal(out.modificationTime, 222);",
      ].join("\n"),
    },
    {
      name: "does not spread read-only or unknown GET fields",
      body: [
        "const out = mod.buildEventSpeakerPutPayload({}, { speakerId: 's-1', speakerType: 'Speaker', ordinal: 3, creationTime: 111, modificationTime: 222, createdBy: 'ada', localizations: { 'en-US': {} }, targetCms: 'readonly' });",
        "assert.deepEqual(Object.keys(out).sort(), ['creationTime', 'modificationTime', 'ordinal', 'speakerId', 'speakerType'].sort());",
      ].join("\n"),
    },
  ],
};
