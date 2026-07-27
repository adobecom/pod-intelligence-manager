import { createHash } from "node:crypto";
import type {
  SkillCatalogLayoutRule,
  SkillConflictCandidate,
  SkillConflictKind,
} from "@pim/shared";
import {
  hashNormalizedSkillContent,
  normalizeSkillName,
} from "@pim/shared/skill-catalog";
import {
  compileSkillLayout,
  deriveSkillNamespace,
} from "./skill-catalog-layout.js";
import { parseSkillMarkdown } from "./skill-catalog-markdown.js";

export const SKILL_CONFLICT_COMMENT_MARKER =
  "<!-- pim-skill-conflict-check -->";
export const DEFAULT_SKILL_RELATED_DISPLAY_FLOOR = 0.35;

export type SkillConflictCheckMode = "advisory" | "required";
export type SkillConflictCheckOutcome =
  | "clear"
  | "conflict_found"
  | "unavailable";

interface PullRequestFile {
  filename: string;
  previous_filename?: string;
  status: "added" | "modified" | "renamed" | "removed" | string;
}

interface GitHubContentResponse {
  type?: string;
  encoding?: string;
  content?: string;
}

interface GitHubComment {
  id: number;
  body?: string;
  user?: { type?: string };
}

interface SkillCatalogSourceStatusResponse {
  layoutRules: SkillCatalogLayoutRule[];
  excludeGlobs: string[];
}

interface ExistingConflictShape {
  kind: string;
  existing?: { path?: string };
  existingCandidate?: { candidateId?: string; proposedPath?: string };
}

interface RelatedSkillShape {
  name: string;
  namespace: string;
  path: string;
  blobSha: string;
  similarity: number;
  excerpt: string;
}

interface ConflictResultShape {
  candidateId: string;
  status: "clear" | "conflict_found";
  conflicts: ExistingConflictShape[];
  related?: RelatedSkillShape[];
}

interface SkillConflictResponseShape {
  catalog: { commitSha: string; snapshotState: string };
  matcherVersion: string;
  results: ConflictResultShape[];
}

export interface PullRequestCheckEvent {
  action?: string;
  pull_request: {
    number: number;
    base: { sha: string };
    head: { sha: string };
    state?: string;
    merged?: boolean;
  };
  repository?: { full_name?: string };
}

export interface SkillConflictLabelRecord {
  schemaVersion: "pim.skill-conflict-label.v1";
  repository: string;
  pullRequest: {
    number: number;
    baseSha: string;
    headSha: string;
    action: string | null;
    state: string | null;
    merged: boolean | null;
  };
  catalog: {
    commitSha: string | null;
    matcherVersion: string | null;
  };
  changes: {
    removedPaths: string[];
    renames: Array<{ from: string; to: string }>;
  };
  candidates: Array<{
    candidateId: string;
    path: string;
    contentHash: string;
    status: "clear" | "conflict_found" | "unavailable";
    shownRelated: Array<{
      path: string;
      blobSha: string;
      similarity: number;
    }>;
  }>;
}

export interface AdvisorySkillConflictCheckConfig {
  mode?: SkillConflictCheckMode;
  pimBaseUrl: string;
  pimServiceToken: string;
  pimOrg: string;
  sourceId: string;
  githubToken: string;
  githubRepository: string;
  githubApiUrl?: string;
  maxBuildAttempts?: number;
  relatedDisplayFloor?: number;
}

export interface AdvisorySkillConflictCheckResult {
  mode: SkillConflictCheckMode;
  outcome: SkillConflictCheckOutcome;
  candidateCount: number;
  conflictCount: number;
  relatedCount: number;
  unavailable: boolean;
  commentBody: string | null;
  commentPosted: boolean;
  commentError: string | null;
  labelRecord: SkillConflictLabelRecord;
}

export interface SkillConflictCheckDecision {
  mode: SkillConflictCheckMode;
  outcome: SkillConflictCheckOutcome;
  blocked: boolean;
  exitCode: 0 | 1;
}

export interface AdvisorySkillConflictCheckDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type SkillConflictCheckConfig = AdvisorySkillConflictCheckConfig;
export type SkillConflictCheckResult = AdvisorySkillConflictCheckResult;
export type SkillConflictCheckDependencies =
  AdvisorySkillConflictCheckDependencies;

const MAX_BATCH_CANDIDATES = 20;
const MAX_BATCH_BYTES = 900 * 1024;
const MAX_CANDIDATE_BYTES = 256 * 1024;
const MAX_CANDIDATE_ID_LENGTH = 200;
const MAX_RELATED_COMMENT_ITEMS = 50;
const DETERMINISTIC_CONFLICT_KINDS = new Set<SkillConflictKind>([
  "exact_path",
  "same_namespace_name",
  "exact_content",
  "candidate_exact_path",
  "candidate_same_namespace_name",
  "candidate_exact_content",
]);

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function decideSkillConflictCheck(input: {
  mode: SkillConflictCheckMode;
  conflictCount: number;
  unavailable: boolean;
}): SkillConflictCheckDecision {
  const outcome: SkillConflictCheckOutcome = input.unavailable
    ? "unavailable"
    : input.conflictCount > 0
      ? "conflict_found"
      : "clear";
  const blocked = input.mode === "required" && outcome !== "clear";
  return {
    mode: input.mode,
    outcome,
    blocked,
    exitCode: blocked ? 1 : 0,
  };
}

function checkResult(input: {
  mode: SkillConflictCheckMode;
  candidateCount: number;
  conflictCount: number;
  relatedCount: number;
  unavailable: boolean;
  commentBody: string | null;
  commentPosted: boolean;
  commentError: string | null;
  labelRecord: SkillConflictLabelRecord;
}): SkillConflictCheckResult {
  const decision = decideSkillConflictCheck(input);
  return {
    mode: decision.mode,
    outcome: decision.outcome,
    candidateCount: input.candidateCount,
    conflictCount: input.conflictCount,
    relatedCount: input.relatedCount,
    unavailable: input.unavailable,
    commentBody: input.commentBody,
    commentPosted: input.commentPosted,
    commentError: input.commentError,
    labelRecord: input.labelRecord,
  };
}

function requireRelatedDisplayFloor(value: number | undefined): number {
  const floor = value ?? DEFAULT_SKILL_RELATED_DISPLAY_FLOOR;
  if (!Number.isFinite(floor) || floor < -1 || floor > 1) {
    throw new Error("relatedDisplayFloor must be a finite number from -1 to 1");
  }
  return floor;
}

function githubPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function candidateIdForPath(path: string): string {
  if (path.length <= MAX_CANDIDATE_ID_LENGTH) return path;
  return `path-sha256:${createHash("sha256").update(path, "utf8").digest("hex")}`;
}

async function responseDetail(response: Response): Promise<string> {
  return (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
}

async function requireJson<T>(
  response: Response,
  operation: string,
): Promise<T> {
  if (!response.ok) {
    const detail = await responseDetail(response);
    throw new Error(
      `${operation} failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as T;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeConflictResponse(
  value: unknown,
  candidates: SkillConflictCandidate[],
  baseCommitSha: string,
): SkillConflictResponseShape {
  const record = objectRecord(value);
  const catalog = objectRecord(record?.catalog);
  if (
    !record ||
    !catalog ||
    typeof catalog.commitSha !== "string" ||
    catalog.commitSha.toLowerCase() !== baseCommitSha.toLowerCase() ||
    !["entries_ready", "search_ready"].includes(
      String(catalog.snapshotState),
    ) ||
    typeof record.matcherVersion !== "string" ||
    !record.matcherVersion.trim() ||
    !Array.isArray(record.results)
  ) {
    throw new Error("PIM returned malformed catalog validation metadata");
  }

  const expectedCandidateIds = new Set(
    candidates.map((candidate) => candidate.candidateId),
  );
  const seenCandidateIds = new Set<string>();
  const results: ConflictResultShape[] = record.results.map((value) => {
    const result = objectRecord(value);
    if (
      !result ||
      typeof result.candidateId !== "string" ||
      !expectedCandidateIds.has(result.candidateId) ||
      seenCandidateIds.has(result.candidateId) ||
      (result.status !== "clear" && result.status !== "conflict_found") ||
      !Array.isArray(result.conflicts)
    ) {
      throw new Error("PIM returned malformed deterministic validation results");
    }
    const conflicts: ExistingConflictShape[] = result.conflicts.map(
      (value) => {
        const conflict = objectRecord(value);
        if (
          !conflict ||
          typeof conflict.kind !== "string" ||
          !DETERMINISTIC_CONFLICT_KINDS.has(
            conflict.kind as SkillConflictKind,
          )
        ) {
          throw new Error(
            "PIM returned an unsupported deterministic conflict kind",
          );
        }
        const existing = objectRecord(conflict.existing);
        const existingCandidate = objectRecord(conflict.existingCandidate);
        return {
          kind: conflict.kind,
          ...(typeof existing?.path === "string"
            ? { existing: { path: existing.path } }
            : {}),
          ...(typeof existingCandidate?.proposedPath === "string"
            ? {
                existingCandidate: {
                  ...(typeof existingCandidate.candidateId === "string"
                    ? { candidateId: existingCandidate.candidateId }
                    : {}),
                  proposedPath: existingCandidate.proposedPath,
                },
              }
            : {}),
        };
      },
    );
    if (
      (result.status === "clear" && conflicts.length > 0) ||
      (result.status === "conflict_found" && conflicts.length === 0)
    ) {
      throw new Error("PIM returned an inconsistent deterministic verdict");
    }
    seenCandidateIds.add(result.candidateId);

    // Similarity is advisory. Malformed entries are discarded rather than
    // converting a valid deterministic verdict into a required-check failure.
    const related = Array.isArray(result.related)
      ? result.related
          .flatMap((value): RelatedSkillShape[] => {
            const item = objectRecord(value);
            if (
              !item ||
              typeof item.name !== "string" ||
              typeof item.namespace !== "string" ||
              typeof item.path !== "string" ||
              typeof item.blobSha !== "string" ||
              typeof item.similarity !== "number" ||
              !Number.isFinite(item.similarity) ||
              typeof item.excerpt !== "string"
            ) {
              return [];
            }
            return [
              {
                name: item.name,
                namespace: item.namespace,
                path: item.path,
                blobSha: item.blobSha,
                similarity: item.similarity,
                excerpt: item.excerpt,
              },
            ];
          })
          .slice(0, 5)
      : [];
    return {
      candidateId: result.candidateId,
      status: result.status,
      conflicts,
      related,
    };
  });
  if (
    results.length !== candidates.length ||
    seenCandidateIds.size !== expectedCandidateIds.size
  ) {
    throw new Error("PIM omitted a deterministic validation result");
  }
  return {
    catalog: {
      commitSha: catalog.commitSha,
      snapshotState: String(catalog.snapshotState),
    },
    matcherVersion: record.matcherVersion,
    results,
  };
}

async function listPullRequestFiles(input: {
  fetchImpl: typeof fetch;
  githubApiUrl: string;
  repository: string;
  pullNumber: number;
  headers: Record<string, string>;
}): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  for (let page = 1; ; page += 1) {
    const response = await input.fetchImpl(
      `${input.githubApiUrl}/repos/${input.repository}/pulls/${input.pullNumber}/files?per_page=100&page=${page}`,
      { headers: input.headers },
    );
    const batch = await requireJson<PullRequestFile[]>(
      response,
      "Listing pull-request files",
    );
    files.push(...batch);
    if (batch.length < 100) return files;
  }
}

async function fetchFileAtRevision(input: {
  fetchImpl: typeof fetch;
  githubApiUrl: string;
  repository: string;
  path: string;
  ref: string;
  headers: Record<string, string>;
}): Promise<string> {
  const response = await input.fetchImpl(
    `${input.githubApiUrl}/repos/${input.repository}/contents/${githubPath(input.path)}?ref=${encodeURIComponent(input.ref)}`,
    { headers: input.headers },
  );
  const content = await requireJson<GitHubContentResponse>(
    response,
    `Fetching ${input.path}`,
  );
  if (
    content.type !== "file" ||
    content.encoding !== "base64" ||
    typeof content.content !== "string"
  ) {
    throw new Error(`GitHub did not return base64 file content for ${input.path}`);
  }
  return Buffer.from(content.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

function batches(candidates: SkillConflictCandidate[]): SkillConflictCandidate[][] {
  const output: SkillConflictCandidate[][] = [];
  let current: SkillConflictCandidate[] = [];
  let currentBytes = 0;
  for (const candidate of candidates) {
    const bytes = Buffer.byteLength(candidate.body, "utf8");
    if (bytes > MAX_CANDIDATE_BYTES) {
      throw new Error(
        `${candidate.proposedPath} exceeds the ${MAX_CANDIDATE_BYTES}-byte validation limit`,
      );
    }
    if (
      current.length >= MAX_BATCH_CANDIDATES ||
      (current.length > 0 && currentBytes + bytes > MAX_BATCH_BYTES)
    ) {
      output.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(candidate);
    currentBytes += bytes;
  }
  if (current.length > 0) output.push(current);
  return output;
}

async function validateBatch(input: {
  fetchImpl: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  pimBaseUrl: string;
  pimHeaders: Record<string, string>;
  sourceId: string;
  baseCommitSha: string;
  candidates: SkillConflictCandidate[];
  maxBuildAttempts: number;
}): Promise<SkillConflictResponseShape> {
  for (let attempt = 1; attempt <= input.maxBuildAttempts; attempt += 1) {
    const response = await input.fetchImpl(`${input.pimBaseUrl}/api/skill-conflicts`, {
      method: "POST",
      headers: {
        ...input.pimHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sourceId: input.sourceId,
        baseCommitSha: input.baseCommitSha,
        candidates: input.candidates,
      }),
    });
    if (response.status === 202) {
      if (attempt === input.maxBuildAttempts) {
        throw new Error("PIM catalog snapshot did not become ready before the advisory timeout");
      }
      const retryAfter = Number(response.headers.get("retry-after") ?? "2");
      const delaySeconds = Number.isFinite(retryAfter)
        ? Math.min(10, Math.max(1, retryAfter))
        : 2;
      await input.sleep(delaySeconds * 1_000);
      continue;
    }
    const value = await requireJson<unknown>(
      response,
      "Validating skill conflicts",
    );
    return normalizeConflictResponse(
      value,
      input.candidates,
      input.baseCommitSha,
    );
  }
  throw new Error("PIM catalog snapshot did not become ready");
}

function escapeTable(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function conflictTarget(conflict: ExistingConflictShape): string {
  if (conflict.existing?.path) return conflict.existing.path;
  if (conflict.existingCandidate?.proposedPath) {
    return `candidate ${conflict.existingCandidate.candidateId ?? ""} (${conflict.existingCandidate.proposedPath})`;
  }
  return "another catalog entry";
}

function shownRelated(
  results: ConflictResultShape[],
  floor: number,
): Array<{
  candidateId: string;
  related: RelatedSkillShape;
}> {
  return results
    .flatMap((result) =>
      (result.related ?? [])
        .filter(
          (related) =>
            Number.isFinite(related.similarity) &&
            related.similarity >= floor,
        )
        .map((related) => ({ candidateId: result.candidateId, related })),
    )
    .slice(0, MAX_RELATED_COMMENT_ITEMS);
}

function buildLabelRecord(input: {
  repository: string;
  event: PullRequestCheckEvent;
  candidates: SkillConflictCandidate[];
  results: ConflictResultShape[];
  touchedSkills: PullRequestFile[];
  relatedDisplayFloor: number;
  unavailable: boolean;
  catalogCommitSha: string | null;
  matcherVersion: string | null;
}): SkillConflictLabelRecord {
  const resultByCandidateId = new Map(
    input.results.map((result) => [result.candidateId, result]),
  );
  const shownRelatedByCandidate = new Map<string, RelatedSkillShape[]>();
  for (const item of shownRelated(
    input.results,
    input.relatedDisplayFloor,
  )) {
    const candidateRelated =
      shownRelatedByCandidate.get(item.candidateId) ?? [];
    candidateRelated.push(item.related);
    shownRelatedByCandidate.set(item.candidateId, candidateRelated);
  }
  return {
    schemaVersion: "pim.skill-conflict-label.v1",
    repository: input.repository,
    pullRequest: {
      number: input.event.pull_request.number,
      baseSha: input.event.pull_request.base.sha,
      headSha: input.event.pull_request.head.sha,
      action: input.event.action ?? null,
      state: input.event.pull_request.state ?? null,
      merged: input.event.pull_request.merged ?? null,
    },
    catalog: {
      commitSha: input.catalogCommitSha,
      matcherVersion: input.matcherVersion,
    },
    changes: {
      removedPaths: input.touchedSkills
        .filter((file) => file.status === "removed")
        .map((file) => file.filename)
        .sort(),
      renames: input.touchedSkills
        .filter(
          (file) =>
            file.status === "renamed" &&
            typeof file.previous_filename === "string",
        )
        .map((file) => ({
          from: file.previous_filename!,
          to: file.filename,
        }))
        .sort(
          (left, right) =>
            left.from.localeCompare(right.from) ||
            left.to.localeCompare(right.to),
        ),
    },
    candidates: input.candidates.map((candidate) => {
      const result = resultByCandidateId.get(candidate.candidateId);
      return {
        candidateId: candidate.candidateId,
        path: candidate.proposedPath,
        contentHash: hashNormalizedSkillContent(candidate.body),
        status: input.unavailable
          ? "unavailable"
          : (result?.status ?? "unavailable"),
        shownRelated: (shownRelatedByCandidate.get(candidate.candidateId) ?? [])
          .map((related) => ({
            path: related.path,
            blobSha: related.blobSha,
            similarity: related.similarity,
          })),
      };
    }),
  };
}

function addCrossBatchCandidateConflicts(
  candidates: SkillConflictCandidate[],
  results: ConflictResultShape[],
  batchByCandidateId: Map<string, number>,
): void {
  const resultById = new Map(results.map((result) => [result.candidateId, result]));
  const contentHashes = new Map(
    candidates.map((candidate) => [
      candidate.candidateId,
      hashNormalizedSkillContent(candidate.body),
    ]),
  );
  const add = (
    candidate: SkillConflictCandidate,
    other: SkillConflictCandidate,
    kind: string,
  ) => {
    const result = resultById.get(candidate.candidateId);
    if (!result) return;
    result.status = "conflict_found";
    result.conflicts.push({
      kind,
      existingCandidate: {
        candidateId: other.candidateId,
        proposedPath: other.proposedPath,
      },
    });
  };

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < candidates.length;
      rightIndex += 1
    ) {
      const left = candidates[leftIndex];
      const right = candidates[rightIndex];
      if (
        batchByCandidateId.get(left.candidateId) ===
        batchByCandidateId.get(right.candidateId)
      ) {
        continue;
      }
      if (left.proposedPath === right.proposedPath) {
        add(left, right, "candidate_exact_path");
        add(right, left, "candidate_exact_path");
      }
      if (
        left.targetNamespace === right.targetNamespace &&
        normalizeSkillName(left.name) === normalizeSkillName(right.name)
      ) {
        add(left, right, "candidate_same_namespace_name");
        add(right, left, "candidate_same_namespace_name");
      }
      if (
        contentHashes.get(left.candidateId) === contentHashes.get(right.candidateId)
      ) {
        add(left, right, "candidate_exact_content");
        add(right, left, "candidate_exact_content");
      }
    }
  }
}

export function renderSkillConflictCheckComment(input: {
  mode?: SkillConflictCheckMode;
  candidates: SkillConflictCandidate[];
  results?: ConflictResultShape[];
  relatedDisplayFloor?: number;
  unavailableMessage?: string;
}): string {
  const mode = input.mode ?? "advisory";
  const required = mode === "required";
  const relatedDisplayFloor = requireRelatedDisplayFloor(
    input.relatedDisplayFloor,
  );
  const lines = [
    SKILL_CONFLICT_COMMENT_MARKER,
    `## PIM skill conflict check (${mode})`,
    "",
    required
      ? "This required check blocks deterministic conflicts and unavailable validation."
      : "This advisory check reports deterministic matches but does not fail the pull request.",
    "",
  ];
  if (input.unavailableMessage) {
    lines.push(
      `⚠️ Validation was unavailable: ${escapeTable(input.unavailableMessage)}.`,
      "",
      required
        ? "The required check cannot pass without a deterministic verdict."
        : "The advisory job remains non-blocking.",
    );
    return lines.join("\n");
  }

  const conflicts = (input.results ?? []).flatMap((result) =>
    result.conflicts.map((conflict) => ({
      candidateId: result.candidateId,
      conflict,
    })),
  );
  if (conflicts.length === 0) {
    lines.push(
      `No deterministic conflicts found across ${input.candidates.length} added, modified, or renamed skill file${input.candidates.length === 1 ? "" : "s"}.`,
    );
  } else {
    lines.push(
      "| Candidate | Kind | Existing match |",
      "| --- | --- | --- |",
    );
  }
  const candidatePaths = new Map(
    input.candidates.map((candidate) => [
      candidate.candidateId,
      candidate.proposedPath,
    ]),
  );
  for (const { candidateId, conflict } of conflicts) {
    lines.push(
      `| \`${escapeTable(candidatePaths.get(candidateId) ?? candidateId)}\` | \`${escapeTable(conflict.kind)}\` | \`${escapeTable(conflictTarget(conflict))}\` |`,
    );
  }

  const related = shownRelated(input.results ?? [], relatedDisplayFloor);
  const relatedAboveFloor = (input.results ?? []).reduce(
    (total, result) =>
      total +
      (result.related ?? []).filter(
        (item) =>
          Number.isFinite(item.similarity) &&
          item.similarity >= relatedDisplayFloor,
      ).length,
    0,
  );
  if (related.length > 0) {
    lines.push(
      "",
      "### Related skills (advisory)",
      "",
      "These similarity suggestions are informational and never block this check.",
      "",
      "| Candidate | Related skill | Score | Redacted excerpt |",
      "| --- | --- | ---: | --- |",
    );
    for (const item of related) {
      lines.push(
        `| \`${escapeTable(candidatePaths.get(item.candidateId) ?? item.candidateId)}\` | \`${escapeTable(item.related.path)}\` | ${item.related.similarity.toFixed(3)} | ${escapeTable(item.related.excerpt)} |`,
      );
    }
    if (related.length < relatedAboveFloor) {
      lines.push(
        "",
        `Showing the first ${related.length} of ${relatedAboveFloor} related suggestions to keep this comment bounded.`,
      );
    }
  }
  return lines.join("\n");
}

export function renderAdvisoryConflictComment(input: {
  candidates: SkillConflictCandidate[];
  results?: ConflictResultShape[];
  relatedDisplayFloor?: number;
  unavailableMessage?: string;
}): string {
  return renderSkillConflictCheckComment({ ...input, mode: "advisory" });
}

async function upsertPullRequestComment(input: {
  fetchImpl: typeof fetch;
  githubApiUrl: string;
  repository: string;
  pullNumber: number;
  headers: Record<string, string>;
  body: string;
}): Promise<void> {
  const comments: GitHubComment[] = [];
  for (let page = 1; ; page += 1) {
    const listResponse = await input.fetchImpl(
      `${input.githubApiUrl}/repos/${input.repository}/issues/${input.pullNumber}/comments?per_page=100&page=${page}`,
      { headers: input.headers },
    );
    const batch = await requireJson<GitHubComment[]>(
      listResponse,
      "Listing pull-request comments",
    );
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const existing = comments.find((comment) =>
    comment.body?.includes(SKILL_CONFLICT_COMMENT_MARKER),
  );
  const url = existing
    ? `${input.githubApiUrl}/repos/${input.repository}/issues/comments/${existing.id}`
    : `${input.githubApiUrl}/repos/${input.repository}/issues/${input.pullNumber}/comments`;
  const response = await input.fetchImpl(url, {
    method: existing ? "PATCH" : "POST",
    headers: {
      ...input.headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: input.body }),
  });
  if (!response.ok) {
    const detail = await responseDetail(response);
    throw new Error(
      `Posting skill-conflict PR comment failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
}

async function tryUpsertPullRequestComment(
  input: Parameters<typeof upsertPullRequestComment>[0],
): Promise<string | null> {
  try {
    await upsertPullRequestComment(input);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runSkillConflictCheck(
  config: SkillConflictCheckConfig,
  event: PullRequestCheckEvent,
  dependencies: SkillConflictCheckDependencies = {},
): Promise<SkillConflictCheckResult> {
  const mode = config.mode ?? "advisory";
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const githubApiUrl = normalizedBaseUrl(
    config.githubApiUrl ?? "https://api.github.com",
  );
  const pimBaseUrl = normalizedBaseUrl(config.pimBaseUrl);
  const repository =
    config.githubRepository || event.repository?.full_name?.trim() || "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("githubRepository must be owner/repo");
  }
  const relatedDisplayFloor = requireRelatedDisplayFloor(
    config.relatedDisplayFloor,
  );
  const githubHeaders = {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const pimHeaders = {
    Authorization: `Bearer ${config.pimServiceToken}`,
    "X-Pim-Org": config.pimOrg,
  };
  let touchedSkillsForLabel: PullRequestFile[] = [];
  let catalogCommitSha: string | null = null;
  let matcherVersion: string | null = null;
  const unavailable = async (
    candidates: SkillConflictCandidate[],
    error: unknown,
  ): Promise<SkillConflictCheckResult> => {
    const message = error instanceof Error ? error.message : String(error);
    const commentBody = renderSkillConflictCheckComment({
      mode,
      candidates,
      relatedDisplayFloor,
      unavailableMessage: message,
    });
    const commentError = await tryUpsertPullRequestComment({
      fetchImpl,
      githubApiUrl,
      repository,
      pullNumber: event.pull_request.number,
      headers: githubHeaders,
      body: commentBody,
    });
    return checkResult({
      mode,
      candidateCount: candidates.length,
      conflictCount: 0,
      relatedCount: 0,
      unavailable: true,
      commentBody,
      commentPosted: commentError === null,
      commentError,
      labelRecord: buildLabelRecord({
        repository,
        event,
        candidates,
        results: [],
        touchedSkills: touchedSkillsForLabel,
        relatedDisplayFloor,
        unavailable: true,
        catalogCommitSha,
        matcherVersion,
      }),
    });
  };

  const [sourceResponse, changedFiles] = await Promise.all([
    fetchImpl(
      `${pimBaseUrl}/api/skill-catalog/sources/${encodeURIComponent(config.sourceId)}`,
      { headers: pimHeaders },
    ),
    listPullRequestFiles({
      fetchImpl,
      githubApiUrl,
      repository,
      pullNumber: event.pull_request.number,
      headers: githubHeaders,
    }),
  ]);
  let source: SkillCatalogSourceStatusResponse;
  try {
    source = await requireJson<SkillCatalogSourceStatusResponse>(
      sourceResponse,
      "Reading skill catalog source layout",
    );
  } catch (error) {
    return unavailable([], error);
  }
  let layout;
  try {
    layout = compileSkillLayout(source.layoutRules, source.excludeGlobs ?? []);
  } catch (error) {
    return unavailable([], error);
  }
  const touchedSkills = changedFiles.filter((file) => {
    const current = deriveSkillNamespace(file.filename, layout);
    const previous = file.previous_filename
      ? deriveSkillNamespace(file.previous_filename, layout)
      : null;
    return Boolean(current || previous);
  });
  touchedSkillsForLabel = touchedSkills;
  const candidateFiles = touchedSkills.filter((file) =>
    ["added", "modified", "renamed"].includes(file.status),
  );

  if (touchedSkills.length === 0) {
    return checkResult({
      mode,
      candidateCount: 0,
      conflictCount: 0,
      relatedCount: 0,
      unavailable: false,
      commentBody: null,
      commentPosted: false,
      commentError: null,
      labelRecord: buildLabelRecord({
        repository,
        event,
        candidates: [],
        results: [],
        touchedSkills,
        relatedDisplayFloor,
        unavailable: false,
        catalogCommitSha: null,
        matcherVersion: null,
      }),
    });
  }

  let candidates: SkillConflictCandidate[];
  try {
    candidates = (
      await Promise.all(
        candidateFiles.map(async (file): Promise<SkillConflictCandidate | null> => {
          const targetNamespace = deriveSkillNamespace(file.filename, layout);
          if (!targetNamespace) return null;
          const body = await fetchFileAtRevision({
            fetchImpl,
            githubApiUrl,
            repository,
            path: file.filename,
            ref: event.pull_request.head.sha,
            headers: githubHeaders,
          });
          const parsed = parseSkillMarkdown(file.filename, body);
          return {
            candidateId: candidateIdForPath(file.filename),
            name: parsed.normalizedName,
            ...(parsed.description ? { description: parsed.description } : {}),
            proposedPath: file.filename,
            targetNamespace,
            body,
            ...(file.status === "modified"
              ? { replacesPath: file.filename }
              : file.status === "renamed" && file.previous_filename
                ? { replacesPath: file.previous_filename }
                : {}),
          };
        }),
      )
    ).filter((candidate): candidate is SkillConflictCandidate => candidate !== null);
  } catch (error) {
    return unavailable([], error);
  }

  try {
    const results: ConflictResultShape[] = [];
    const candidateBatches = batches(candidates);
    const batchByCandidateId = new Map<string, number>();
    candidateBatches.forEach((batch, batchIndex) => {
      for (const candidate of batch) {
        batchByCandidateId.set(candidate.candidateId, batchIndex);
      }
    });
    for (const batch of candidateBatches) {
      const response = await validateBatch({
        fetchImpl,
        sleep,
        pimBaseUrl,
        pimHeaders,
        sourceId: config.sourceId,
        baseCommitSha: event.pull_request.base.sha,
        candidates: batch,
        maxBuildAttempts: Math.max(1, config.maxBuildAttempts ?? 20),
      });
      if (
        (catalogCommitSha !== null &&
          catalogCommitSha !== response.catalog.commitSha) ||
        (matcherVersion !== null && matcherVersion !== response.matcherVersion)
      ) {
        throw new Error(
          "PIM returned inconsistent catalog metadata across validation batches",
        );
      }
      catalogCommitSha = response.catalog.commitSha;
      matcherVersion = response.matcherVersion;
      results.push(...response.results);
    }
    addCrossBatchCandidateConflicts(candidates, results, batchByCandidateId);
    const commentBody = renderSkillConflictCheckComment({
      mode,
      candidates,
      results,
      relatedDisplayFloor,
    });
    const commentError = await tryUpsertPullRequestComment({
      fetchImpl,
      githubApiUrl,
      repository,
      pullNumber: event.pull_request.number,
      headers: githubHeaders,
      body: commentBody,
    });
    return checkResult({
      mode,
      candidateCount: candidates.length,
      conflictCount: results.reduce(
        (total, result) => total + result.conflicts.length,
        0,
      ),
      relatedCount: shownRelated(results, relatedDisplayFloor).length,
      unavailable: false,
      commentBody,
      commentPosted: commentError === null,
      commentError,
      labelRecord: buildLabelRecord({
        repository,
        event,
        candidates,
        results,
        touchedSkills,
        relatedDisplayFloor,
        unavailable: false,
        catalogCommitSha,
        matcherVersion,
      }),
    });
  } catch (error) {
    return unavailable(candidates, error);
  }
}

export async function runAdvisorySkillConflictCheck(
  config: AdvisorySkillConflictCheckConfig,
  event: PullRequestCheckEvent,
  dependencies: AdvisorySkillConflictCheckDependencies = {},
): Promise<AdvisorySkillConflictCheckResult> {
  return runSkillConflictCheck(
    { ...config, mode: "advisory" },
    event,
    dependencies,
  );
}
