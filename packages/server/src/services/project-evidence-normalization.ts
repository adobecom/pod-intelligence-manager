import crypto from "node:crypto";
import type { ProjectEvidenceSource, ProjectEvidenceVisibility } from "@pim/shared";
import { redactSecrets } from "./secret-scan.js";

/** Bump when deterministic normalization, metadata admission, or redaction rules change. */
export const PROJECT_EVIDENCE_REDACTION_VERSION = "project-evidence-v2";

const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_ARRAY_ITEMS = 200;
const SENSITIVE_QUERY_KEY = /^(?:[a-z0-9]+[_-])*(?:auth|authorization|code|jwt|key|sig|signature|access[_-]?token|refresh[_-]?token|id[_-]?token|private[_-]?token|token|secret|password|credential|cookie|session|api[_-]?key)(?:[_-][a-z0-9]+)*$/i;
const SENSITIVE_METADATA_KEY = /(?:credential|password|secret|token|api[_-]?key|authorization|cookie)/i;

const COMMON_METADATA_KEYS = new Set([
  "binding_key", "resource_binding_version", "domains", "status", "state", "visibility", "visibility_version", "updated_at", "created_at",
]);

const SOURCE_METADATA_KEYS: Record<string, ReadonlySet<string>> = {
  github: new Set(["repo", "number", "sha", "branch", "merged", "labels"]),
  jira: new Set([
    "key", "status_category", "issue_type", "priority", "assignee", "reporter", "components", "labels",
    "fix_versions", "parent", "parent_summary", "due_date", "resolved", "name", "project_key", "released",
    "release_date", "overdue",
  ]),
  slack: new Set([
    "workspace", "workspace_id", "team_id", "channel_id", "channel_name", "thread_ts", "root_ts", "message_ts",
    "message_timestamps", "message_permalinks", "reply_count", "latest_reply", "last_activity", "participants",
    "reactions", "thread_url", "question", "resolution", "referenced_systems",
  ]),
  confluence: new Set([
    "site", "site_id", "site_url", "page_id", "space_key", "version", "page_version", "page_title", "headings",
    "section_index", "section_count", "heading", "heading_path", "section_path", "previous_native_id", "next_native_id",
    "anchor",
  ]),
  commit: new Set(["repo", "repo_path", "sha", "branch", "path"]),
  git: new Set(["repo", "repo_path", "sha", "branch", "path", "line", "symbol", "symbols", "imports"]),
  project_update: new Set(["scope", "agent_id"]),
  pod_update: new Set(["scope", "agent_id", "pod_id"]),
  kg: new Set(["node_id", "type", "confidence_score", "curated", "project_ids"]),
};

export class ProjectEvidenceNormalizationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectEvidenceNormalizationError";
    this.code = code;
  }
}

export interface ProjectEvidenceNormalizationInput {
  source: ProjectEvidenceSource | string;
  source_type: string;
  source_id: string;
  source_instance?: string;
  native_id?: string;
  source_version?: string;
  source_url?: string;
  source_title: string;
  summary: string;
  body: string;
  author?: string;
  metadata?: Record<string, unknown>;
  visibility?: ProjectEvidenceVisibility;
  visibility_version?: string;
  source_updated_at?: string;
}

export interface NormalizedProjectEvidence {
  source_type: string;
  source_id: string;
  source_instance: string;
  native_id: string;
  source_version?: string;
  source_url?: string;
  source_title: string;
  summary: string;
  body: string;
  author?: string;
  metadata: Record<string, unknown>;
  visibility: ProjectEvidenceVisibility;
  visibility_version: string;
  redaction_version: string;
  normalized_content_hash: string;
  source_updated_at?: string;
  findings: string[];
}

export interface ProjectIndexNormalizationInput {
  source: string;
  source_type: string;
  source_id: string;
  source_instance?: string;
  native_id?: string;
  source_version?: string;
  source_url?: string;
  title: string;
  author?: string;
  status?: string;
  body?: string;
  comments?: string[];
  metadata?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  visibility?: ProjectEvidenceVisibility;
  visibility_version?: string;
  redaction_version?: string;
  normalized_content_hash?: string;
  source_updated_at?: string;
}

export interface NormalizedProjectIndexContent extends ProjectIndexNormalizationInput {
  source_instance: string;
  native_id: string;
  title: string;
  body?: string;
  comments?: string[];
  metadata: Record<string, unknown>;
  permissions: Record<string, unknown>;
  visibility: ProjectEvidenceVisibility;
  visibility_version: string;
  redaction_version: string;
  normalized_content_hash: string;
  findings: string[];
}

function normalizeString(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function redactString(value: string, findings: Set<string>): string {
  const redacted = redactSecrets(normalizeString(value));
  for (const finding of redacted.findings) findings.add(finding);
  const withoutUserInfo = redacted.text.replace(
    /(https?:\/\/)([^\s\/@:]+):([^\s\/@]+)@/gi,
    (_match, scheme: string) => {
      findings.add("URL Credential");
      return `${scheme}REDACTED:REDACTED@`;
    },
  );
  return withoutUserInfo.replace(
    /([?&])([A-Za-z0-9_-]+)=([^&#\s]*)/g,
    (match, separator: string, key: string) => {
      if (!SENSITIVE_QUERY_KEY.test(key)) return match;
      findings.add("URL Credential");
      return `${separator}${key}=[REDACTED:URL_CREDENTIAL]`;
    },
  );
}

/** Canonical text-only boundary for transient payloads such as cache values
 * and generated summaries that are not full evidence records. */
export function redactProjectText(value: string): { text: string; findings: string[] } {
  const findings = new Set<string>();
  const text = redactString(value, findings);
  return { text, findings: [...findings].sort() };
}

export function redactProjectUrl(value: string, findings = new Set<string>()): string {
  const normalized = normalizeString(value);
  try {
    const url = new URL(normalized);
    if (url.username) {
      url.username = "REDACTED";
      findings.add("URL Credential");
    }
    if (url.password) {
      url.password = "REDACTED";
      findings.add("URL Credential");
    }
    for (const [key, raw] of [...url.searchParams.entries()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        url.searchParams.set(key, "[REDACTED:URL_CREDENTIAL]");
        findings.add("URL Credential");
      } else {
        url.searchParams.set(key, redactString(raw, findings));
      }
    }
    return redactString(url.toString(), findings);
  } catch {
    const redacted = normalized.replace(
      /([?&])([A-Za-z0-9_-]+)=([^&#\s]*)/g,
      (match, separator: string, key: string) => {
        if (!SENSITIVE_QUERY_KEY.test(key)) return match;
        findings.add("URL Credential");
        return `${separator}${key}=[REDACTED:URL_CREDENTIAL]`;
      },
    );
    return redactString(redacted, findings);
  }
}

function sanitizeIdentifier(value: string, findings: Set<string>): string {
  const normalized = normalizeString(value);
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)
    ? redactProjectUrl(normalized, findings)
    : redactString(normalized, findings);
}

function sanitizeJson(
  value: unknown,
  findings: Set<string>,
  seen: Set<object>,
  depth: number,
): unknown {
  if (depth > MAX_METADATA_DEPTH) {
    throw new ProjectEvidenceNormalizationError("metadata_depth", "Evidence metadata exceeds the supported nesting depth");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProjectEvidenceNormalizationError("metadata_number", "Evidence metadata contains a non-finite number");
    return value;
  }
  if (typeof value === "string") return redactString(value, findings);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ProjectEvidenceNormalizationError("metadata_cycle", "Evidence metadata contains a cycle");
    seen.add(value);
    const out = value.slice(0, MAX_METADATA_ARRAY_ITEMS).map((item) => sanitizeJson(item, findings, seen, depth + 1));
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new ProjectEvidenceNormalizationError("metadata_cycle", "Evidence metadata contains a cycle");
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      // Match JSON object semantics while staying fail-closed for unsupported
      // values that would otherwise be persisted ambiguously.
      if (child === undefined) continue;
      if (SENSITIVE_METADATA_KEY.test(key)) {
        out["[REDACTED:Metadata Credential]"] = "[REDACTED:Metadata Credential]";
        findings.add("Metadata Credential");
        continue;
      }
      const safeKey = redactString(key, findings);
      out[safeKey] = sanitizeJson(child, findings, seen, depth + 1);
    }
    seen.delete(value);
    return out;
  }
  throw new ProjectEvidenceNormalizationError("metadata_type", "Evidence metadata contains an unsupported value type");
}

export function allowlistedProjectMetadata(
  source: string,
  metadata: Record<string, unknown> | undefined,
  findings = new Set<string>(),
): Record<string, unknown> {
  if (!metadata) return {};
  const allowed = SOURCE_METADATA_KEYS[source] ?? new Set<string>();
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(metadata).sort()) {
    if (COMMON_METADATA_KEYS.has(key) || allowed.has(key)) picked[key] = metadata[key];
  }
  return sanitizeJson(picked, findings, new Set<object>(), 0) as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedHash(value: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function defaultSourceInstance(source: string, sourceUrl?: string): string {
  if (sourceUrl) {
    try {
      return new URL(sourceUrl).origin;
    } catch {
      // Fall through to the deterministic source label.
    }
  }
  return source === "project_update" || source === "pod_update" || source === "kg" ? "pim" : source;
}

export function normalizeProjectEvidence(input: ProjectEvidenceNormalizationInput): NormalizedProjectEvidence {
  const findings = new Set<string>();
  const sourceUrl = input.source_url ? redactProjectUrl(input.source_url, findings) : undefined;
  const sourceInstance = sanitizeIdentifier(input.source_instance ?? defaultSourceInstance(input.source, sourceUrl), findings);
  const nativeId = sanitizeIdentifier(input.native_id ?? input.source_id, findings);
  const sourceId = sanitizeIdentifier(input.source_id, findings);
  const sourceType = redactString(input.source_type, findings);
  const sourceTitle = redactString(input.source_title, findings);
  const summary = redactString(input.summary, findings);
  const body = redactString(input.body, findings);
  const author = input.author ? redactString(input.author, findings) : undefined;
  const metadata = allowlistedProjectMetadata(input.source, input.metadata, findings);
  const sourceVersion = input.source_version ? redactString(input.source_version, findings) : undefined;
  const visibility = input.visibility ?? "project_visible";
  const visibilityVersion = redactString(input.visibility_version ?? "1", findings) || "1";
  const sourceUpdatedAt = input.source_updated_at ? redactString(input.source_updated_at, findings) : undefined;
  const normalizedContentHash = normalizedHash({
    source_type: sourceType,
    source_url: sourceUrl ?? null,
    source_title: sourceTitle,
    summary,
    body,
    author: author ?? null,
    metadata,
  });

  return {
    source_type: sourceType,
    source_id: sourceId,
    source_instance: sourceInstance,
    native_id: nativeId,
    ...(sourceVersion ? { source_version: sourceVersion } : {}),
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    source_title: sourceTitle,
    summary,
    body,
    ...(author ? { author } : {}),
    metadata,
    visibility,
    visibility_version: visibilityVersion,
    redaction_version: PROJECT_EVIDENCE_REDACTION_VERSION,
    normalized_content_hash: normalizedContentHash,
    ...(sourceUpdatedAt ? { source_updated_at: sourceUpdatedAt } : {}),
    findings: [...findings].sort(),
  };
}

/** Defense-in-depth for direct index callers (local git, KG, updates, tests).
 * Evidence callers normally arrive pre-normalized, but applying this transform
 * twice is deterministic and does not expose already-redacted values. */
export function normalizeProjectIndexContent(input: ProjectIndexNormalizationInput): NormalizedProjectIndexContent {
  const normalized = normalizeProjectEvidence({
    source: input.source,
    source_type: input.source_type,
    source_id: input.source_id,
    source_instance: input.source_instance,
    native_id: input.native_id,
    source_version: input.source_version,
    source_url: input.source_url,
    source_title: input.title,
    summary: input.title,
    body: input.body ?? "",
    author: input.author,
    metadata: input.metadata,
    visibility: input.visibility,
    visibility_version: input.visibility_version,
    source_updated_at: input.source_updated_at,
  });
  const findings = new Set(normalized.findings);
  const comments = input.comments?.map((comment) => redactString(comment, findings));
  const status = input.status ? redactString(input.status, findings) : undefined;
  const permissions = sanitizeJson(input.permissions ?? {}, findings, new Set<object>(), 0) as Record<string, unknown>;
  permissions.visibility = normalized.visibility;
  const contentHash = normalizedHash({
    title: normalized.source_title,
    status: status ?? null,
    body: normalized.body,
    comments: comments ?? [],
    metadata: normalized.metadata,
  });
  return {
    ...input,
    source_type: normalized.source_type,
    source_id: normalized.source_id,
    source_instance: normalized.source_instance,
    native_id: normalized.native_id,
    ...(normalized.source_version ? { source_version: normalized.source_version } : {}),
    ...(normalized.source_url ? { source_url: normalized.source_url } : {}),
    title: normalized.source_title,
    ...(normalized.author ? { author: normalized.author } : {}),
    ...(status ? { status } : {}),
    body: normalized.body,
    ...(comments ? { comments } : {}),
    metadata: normalized.metadata,
    permissions,
    visibility: normalized.visibility,
    visibility_version: normalized.visibility_version,
    redaction_version: PROJECT_EVIDENCE_REDACTION_VERSION,
    normalized_content_hash: contentHash,
    ...(normalized.source_updated_at ? { source_updated_at: normalized.source_updated_at } : {}),
    findings: [...findings].sort(),
  };
}
