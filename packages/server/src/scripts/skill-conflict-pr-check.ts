/**
 * Mimir pull-request backstop for deterministic skill conflicts.
 *
 * PIM_SKILL_CHECK_MODE defaults to `advisory`. In `required` mode,
 * deterministic conflicts and unavailable validation produce exit code 1.
 * Configuration and event errors fail in both modes.
 */
import fs from "node:fs";
import {
  decideSkillConflictCheck,
  runSkillConflictCheck,
  type PullRequestCheckEvent,
  type SkillConflictLabelRecord,
  type SkillConflictCheckMode,
  type SkillConflictCheckResult,
} from "../services/skill-conflict-pr-check.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function checkMode(): SkillConflictCheckMode {
  const value = process.env.PIM_SKILL_CHECK_MODE?.trim() || "advisory";
  if (value !== "advisory" && value !== "required") {
    throw new Error("PIM_SKILL_CHECK_MODE must be advisory or required");
  }
  return value;
}

function maxBuildAttempts(): number | undefined {
  const value = process.env.PIM_SKILL_CHECK_MAX_ATTEMPTS?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("PIM_SKILL_CHECK_MAX_ATTEMPTS must be a positive integer");
  }
  return parsed;
}

function relatedDisplayFloor(): number | undefined {
  const value = process.env.PIM_SKILL_RELATED_DISPLAY_FLOOR?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -1 || parsed > 1) {
    throw new Error(
      "PIM_SKILL_RELATED_DISPLAY_FLOOR must be a number from -1 to 1",
    );
  }
  return parsed;
}

function readEvent(): PullRequestCheckEvent {
  const eventPath = requiredEnv("GITHUB_EVENT_PATH");
  const event = JSON.parse(
    fs.readFileSync(eventPath, "utf8"),
  ) as PullRequestCheckEvent;
  if (
    !Number.isSafeInteger(event.pull_request?.number) ||
    event.pull_request.number < 1 ||
    !/^[a-f0-9]{40}$/i.test(event.pull_request?.base?.sha ?? "") ||
    !/^[a-f0-9]{40}$/i.test(event.pull_request?.head?.sha ?? "")
  ) {
    throw new Error(
      "GITHUB_EVENT_PATH does not contain a valid pull_request event",
    );
  }
  return event;
}

function writeSummary(input: {
  mode: SkillConflictCheckMode;
  candidateCount: number;
  conflictCount: number;
  relatedCount?: number;
  unavailable: boolean;
  commentPosted?: boolean;
  commentError?: string | null;
  labelRecord?: SkillConflictLabelRecord;
}): 0 | 1 {
  const decision = decideSkillConflictCheck(input);
  const summary = {
    event: "pim_skill_conflict_check",
    mode: decision.mode,
    outcome: decision.outcome,
    blocked: decision.blocked,
    exitCode: decision.exitCode,
    candidateCount: input.candidateCount,
    conflictCount: input.conflictCount,
    relatedCount: input.relatedCount ?? 0,
    unavailable: input.unavailable,
    commentPosted: input.commentPosted ?? false,
    commentError: input.commentError ?? null,
    labelRecord: input.labelRecord ?? null,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (stepSummaryPath && input.labelRecord) {
    try {
      fs.appendFileSync(
        stepSummaryPath,
        [
          "",
          "### PIM skill-conflict label record",
          "",
          "```json",
          JSON.stringify(input.labelRecord, null, 2),
          "```",
          "",
        ].join("\n"),
        "utf8",
      );
    } catch (error) {
      process.stderr.write(
        `PIM skill conflict check could not append GITHUB_STEP_SUMMARY: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  return decision.exitCode;
}

async function executeCheck(input: {
  mode: SkillConflictCheckMode;
  event: PullRequestCheckEvent;
  config: Parameters<typeof runSkillConflictCheck>[0];
}): Promise<void> {
  let result: SkillConflictCheckResult;
  try {
    result = await runSkillConflictCheck(input.config, input.event);
  } catch (error) {
    process.stderr.write(
      `PIM skill conflict check unavailable (${input.mode}): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = writeSummary({
      mode: input.mode,
      candidateCount: 0,
      conflictCount: 0,
      unavailable: true,
    });
    return;
  }
  process.exitCode = writeSummary(result);
}

async function main(): Promise<void> {
  // Resolve configuration and validate the event before entering the
  // mode-dependent runtime failure path. These are workflow defects, not an
  // advisory availability signal, so they always fail.
  const mode = checkMode();
  const event = readEvent();
  const githubRepository =
    process.env.GITHUB_REPOSITORY?.trim() ||
    event.repository?.full_name?.trim() ||
    "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/repo");
  }
  await executeCheck({
    mode,
    event,
    config: {
      mode,
      pimBaseUrl: requiredEnv("PIM_BASE_URL"),
      pimServiceToken: requiredEnv("PIM_SERVICE_TOKEN"),
      pimOrg: requiredEnv("PIM_ORG"),
      sourceId: requiredEnv("PIM_SKILL_SOURCE_ID"),
      githubToken: requiredEnv("GITHUB_TOKEN"),
      githubRepository,
      githubApiUrl: process.env.GITHUB_API_URL?.trim() || undefined,
      maxBuildAttempts: maxBuildAttempts(),
      relatedDisplayFloor: relatedDisplayFloor(),
    },
  });
}

await main().catch((error) => {
  process.stderr.write(
    `PIM skill conflict check configuration/event error: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
