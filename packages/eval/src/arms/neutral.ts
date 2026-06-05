import type { Arm, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { filterFixtureByAsOf, serializeContext } from "./pim-full.js";

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You may be given a neutral context block. It contains no task-relevant facts and should not be treated as evidence.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You may be given a neutral context block. It contains no task-relevant facts and should not be treated as evidence.",
  "Return ONLY the requested content — no preamble, no postscript.",
].join("\n");

const FILLER = [
  "Neutral engineering benchmark filler.",
  "This block is intentionally unrelated to the task.",
  "It discusses general software practices such as naming clarity, review hygiene, test readability, and operational caution.",
  "It contains no product decisions, API contracts, field names, issue identifiers, pull request references, or pod-specific facts.",
  "The model should solve the task using only the task prompt.",
].join(" ");

export const lengthMatchedNeutralArm: Arm = {
  id: "length-matched-neutral",
  label: "Length-matched neutral",
  usesPim: false,
  primary: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    const scoped = fixture && task.asOf ? filterFixtureByAsOf(fixture, task.asOf) : fixture;
    const targetChars = scoped ? serializeContext(scoped).length : 4000;
    const repeats = Math.max(1, Math.ceil(targetChars / (FILLER.length + 1)));
    const neutral = Array.from({ length: repeats }, () => FILLER).join("\n").slice(0, targetChars);
    return {
      system: task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT,
      pimContext: `# Length-Matched Neutral Context\n${neutral}`,
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

export const wrongPodContextArm: Arm = {
  id: "wrong-pod-context",
  label: "Wrong-pod context stress",
  usesPim: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    if (!fixture) throw new Error("wrong-pod-context requires a fixture");
    return {
      system: task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT,
      pimContext: [
        "# Wrong-Pod Stress Context",
        "This fixture must be supplied by the runner from a pod different from the task pod.",
        serializeContext(fixture),
      ].join("\n\n"),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

export const staleContextArm: Arm = {
  id: "stale-context",
  label: "Stale context stress",
  usesPim: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    if (!fixture) throw new Error("stale-context requires a fixture");
    return {
      system: task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT,
      pimContext: [
        "# Stale Context Stress",
        "This context is intentionally stale for stress testing and should be used cautiously.",
        serializeContext(fixture),
      ].join("\n\n"),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

export const contradictoryContextArm: Arm = {
  id: "contradictory-context",
  label: "Contradictory context stress",
  usesPim: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    if (!fixture) throw new Error("contradictory-context requires a fixture");
    return {
      system: task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT,
      pimContext: [
        "# Contradictory Context Stress",
        "This context may intentionally contradict the task ground truth for stress testing.",
        serializeContext(fixture),
      ].join("\n\n"),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};
