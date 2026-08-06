import type {
  CodebaseApplicabilityV1,
  HarnessApplicabilityV1,
  MemoryContentV1,
  OrgApplicabilityV1,
  ValidationV1,
} from "@pim/shared";

export const MEMORY_PLANES = ["codebase", "harness", "org"] as const;
export const THIN_V1_MEMORY_KINDS = ["decision", "constraint", "anti_pattern", "test_strategy"] as const;

export type MemoryPlane = typeof MEMORY_PLANES[number];
export type ThinV1MemoryKind = typeof THIN_V1_MEMORY_KINDS[number];

export interface MemoryStructuralIssue {
  path: string;
  reason: string;
}

export interface StructuralMemoryInput {
  plane: MemoryPlane;
  kind: ThinV1MemoryKind;
  content: MemoryContentV1;
  applicability: CodebaseApplicabilityV1 | HarnessApplicabilityV1 | OrgApplicabilityV1;
  validation: ValidationV1;
  exceptions: string[];
}

export class MemoryStructuralValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "schema_invalid";
  readonly issues: MemoryStructuralIssue[];

  constructor(issues: MemoryStructuralIssue[]) {
    super("Memory activation failed structural validation");
    this.name = "MemoryStructuralValidationError";
    this.issues = issues;
  }
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

export function normalizeRepositoryId(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\/+$/, "");
  return /^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized) ? normalized : null;
}

function contentIssues(content: MemoryContentV1): MemoryStructuralIssue[] {
  const issues: MemoryStructuralIssue[] = [];
  if (typeof content.summary !== "string" || content.summary.trim().length < 10 || content.summary.length > 500) {
    issues.push({ path: "/content/summary", reason: "must contain 10 to 500 characters" });
  }
  if (typeof content.details !== "string" || content.details.trim().length < 30 || content.details.length > 8000) {
    issues.push({ path: "/content/details", reason: "must contain 30 to 8000 characters" });
  }
  if (typeof content.rationale !== "string" || content.rationale.trim().length < 10 || content.rationale.length > 4000) {
    issues.push({ path: "/content/rationale", reason: "must contain 10 to 4000 characters" });
  }
  return issues;
}

function isCodebaseApplicability(value: StructuralMemoryInput["applicability"]): value is CodebaseApplicabilityV1 {
  return typeof (value as { repository_id?: unknown }).repository_id === "string";
}

function isHarnessApplicability(value: StructuralMemoryInput["applicability"]): value is HarnessApplicabilityV1 {
  return typeof (value as { harness_id?: unknown }).harness_id === "string";
}

function isOrgApplicability(value: StructuralMemoryInput["applicability"]): value is OrgApplicabilityV1 {
  return Array.isArray((value as { audience?: unknown }).audience);
}

export function memoryStructuralIssues(input: StructuralMemoryInput): MemoryStructuralIssue[] {
  const issues = contentIssues(input.content);
  if (!MEMORY_PLANES.includes(input.plane)) issues.push({ path: "/plane", reason: "is not a supported memory plane" });
  if (!THIN_V1_MEMORY_KINDS.includes(input.kind)) issues.push({ path: "/kind", reason: "is not a thin-v1 memory kind" });
  if (!Array.isArray(input.exceptions) || !nonEmptyStrings(input.exceptions)) {
    issues.push({ path: "/exceptions", reason: "must contain only non-empty bounded strings" });
  } else if (input.exceptions.some((item) => item.length > 1000)) {
    issues.push({ path: "/exceptions", reason: "items must contain at most 1000 characters" });
  }

  if (input.plane === "codebase") {
    if (!isCodebaseApplicability(input.applicability)) {
      issues.push({ path: "/applicability", reason: "codebase memory requires codebase applicability" });
    } else {
      const canonical = normalizeRepositoryId(input.applicability.repository_id);
      if (!canonical || canonical !== input.applicability.repository_id) {
        issues.push({ path: "/applicability/repository_id", reason: "must be a canonical case-folded github.com/owner/repo identifier" });
      }
      const hasSelector = Boolean(input.applicability.base_sha)
        || Boolean(input.applicability.components?.length)
        || Boolean(input.applicability.paths?.length)
        || Boolean(input.applicability.symbols?.length)
        || Boolean(input.applicability.task_classes?.length);
      if (!hasSelector) issues.push({ path: "/applicability", reason: "codebase activation requires at least one exact applicability selector" });
    }
    if (input.kind === "anti_pattern") {
      if (input.exceptions.length === 0) issues.push({ path: "/exceptions", reason: "anti-patterns must state where they do not apply" });
      if (input.validation.strategy !== "stable_failure_fingerprint" || !input.validation.failure_fingerprint) {
        issues.push({ path: "/validation", reason: "codebase anti-patterns require a stable failure fingerprint" });
      }
    } else if (input.validation.strategy !== "repository_anchors") {
      issues.push({ path: "/validation/strategy", reason: "positive codebase memory requires repository anchors" });
    }
  } else if (input.plane === "harness") {
    if (!isHarnessApplicability(input.applicability)) {
      issues.push({ path: "/applicability", reason: "harness memory requires harness applicability" });
    } else {
      const hasVersionSelector = Boolean(input.applicability.harness_version_range)
        || Boolean(input.applicability.workflow_version_range)
        || Boolean(input.applicability.adapter_version_range)
        || Boolean(input.applicability.configuration_ids?.length)
        || Boolean(input.applicability.model_ids?.length)
        || Boolean(input.applicability.tool_ids?.length);
      if (!hasVersionSelector) issues.push({ path: "/applicability", reason: "harness activation requires a version, configuration, model, or tool selector" });
    }
    if (input.validation.strategy !== "stable_failure_fingerprint" || !input.validation.failure_fingerprint) {
      issues.push({ path: "/validation", reason: "harness memory requires a stable failure fingerprint" });
    }
  } else if (input.plane === "org") {
    if (!isOrgApplicability(input.applicability)) {
      issues.push({ path: "/applicability", reason: "organization memory requires organization applicability" });
    } else {
      if (!nonEmptyStrings(input.applicability.audience) || input.applicability.audience.length === 0) issues.push({ path: "/applicability/audience", reason: "requires an authorized audience" });
      if (!input.applicability.policy_owner?.trim()) issues.push({ path: "/applicability/policy_owner", reason: "requires a policy owner" });
      if (!Number.isFinite(Date.parse(input.applicability.effective_from))) issues.push({ path: "/applicability/effective_from", reason: "requires a valid effective timestamp" });
    }
    if (input.validation.strategy !== "policy_owner_review") {
      issues.push({ path: "/validation/strategy", reason: "organization memory requires policy-owner review" });
    }
  }
  return issues;
}

export function assertMemoryStructure(input: StructuralMemoryInput): void {
  const issues = memoryStructuralIssues(input);
  if (issues.length > 0) throw new MemoryStructuralValidationError(issues);
}

/**
 * Legacy graph paths do not yet carry a v1 plane/applicability envelope. They
 * still pass through this module so no current activation path can bypass the
 * shared bounded-content and kind checks while migration remains staged.
 */
export function assertLegacyActivationStructure(input: {
  type: string;
  summary: string;
  details: string;
  domains?: string[];
}): void {
  const issues: MemoryStructuralIssue[] = [];
  if (typeof input.summary !== "string" || input.summary.trim().length < 10 || input.summary.length > 500) {
    issues.push({ path: "/summary", reason: "must contain 10 to 500 characters" });
  }
  if (typeof input.details !== "string" || input.details.trim().length < 1 || input.details.length > 8000) {
    issues.push({ path: "/details", reason: "must contain 1 to 8000 characters" });
  }
  const mappedKind = input.type === "anti_pattern"
    ? "anti_pattern"
    : input.type === "decision"
      ? "decision"
      : input.type === "pattern" || input.type === "scope_insight" || input.type === "resolved_conflict"
        ? "constraint"
        : null;
  if (!mappedKind) issues.push({ path: "/type", reason: "cannot map to a thin-v1 structural kind" });
  if (input.domains && (!nonEmptyStrings(input.domains) || input.domains.length > 64)) {
    issues.push({ path: "/domains", reason: "must contain at most 64 non-empty domains" });
  }
  if (issues.length > 0) throw new MemoryStructuralValidationError(issues);
}
