import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db, { withImmediateTransaction, withTransaction } from "../db/connection.js";
import type {
  AgentCheckpoint,
  AgentMemoryRollupPolicy,
  AgentResumeContext,
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
  AgentRunStatus,
  AgentSession,
  AgentPromotionIntent,
  Artifact,
  EnhancedPodLearning,
  KnowledgeNodeType,
  MemoryCandidate,
  MemoryCandidateStatus,
  MemoryEntityRef,
  AgentRunKind,
  AgentSideEffectMode,
} from "@pim/shared";
import {
  buildRetrievalText,
  extractEntityRefs,
  persistMemoryEntities,
} from "./memory-enrichment.js";
import { queryKnowledge } from "./knowledge-graph.js";
import { ingestLearnings } from "./ingestion-gateway.js";
import { callLLMJSON, isLLMAvailable, MODELS } from "../pim/llm.js";
import { classifyDecisionDurability, type PodLearning } from "../pim/agents/knowledge-extraction.js";

const AUTO_PROMOTE_CONFIDENCE_MIN = 0.85;
const AGENT_RUN_CONFIDENCE_CAP = 0.7;
const DEFAULT_RECENT_EVENT_LIMIT = 25;
const DETERMINISTIC_AGENT_SESSION_MODEL = "deterministic-agent-session-rollup-v1";
const AGENT_SESSION_LLM_PROMPT = "../../../../prompts/agent-session-knowledge-extraction.md";
const MIN_LEARNING_SUMMARY_LENGTH = 10;
const MIN_LEARNING_DETAILS_LENGTH = 30;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class AgentMemorySequenceError extends Error {
  constructor(message: string, public expectedSeq: number) {
    super(message);
    this.name = "AgentMemorySequenceError";
  }
}

export class AgentRunNotAppendableError extends Error {
  constructor(public runStatus: AgentRunStatus) {
    super(`Cannot append events to a ${runStatus} agent run`);
    this.name = "AgentRunNotAppendableError";
  }
}

type JsonRecord = Record<string, unknown>;

interface SessionRow {
  session_id: string;
  org_id: string;
  project_id: string | null;
  pod_id: string | null;
  scope: string | null;
  agent_id: string;
  status: AgentSession["status"];
  goal: string | null;
  current_task: string | null;
  working_state_json: string;
  compacted_summary: string | null;
  last_compacted_event_rowid: number;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

interface RunRow {
  run_id: string;
  session_id: string;
  org_id: string;
  project_id: string | null;
  pod_id: string | null;
  scope: string | null;
  agent_id: string;
  status: AgentRunStatus;
  input_prompt: string | null;
  model: string | null;
  provider: string | null;
  metadata_json: string;
  token_input_count: number;
  token_output_count: number;
  total_cost_usd: number;
  error_message: string | null;
  final_output: string | null;
  context_update_id: string | null;
  compacted_summary: string | null;
  started_at: string;
  ended_at: string | null;
}

interface EventRow {
  id: string;
  run_id: string;
  session_id: string;
  org_id: string;
  seq: number;
  event_type: AgentRunEventType;
  payload_json: string;
  summary: string | null;
  artifact_refs_json: string;
  token_count: number;
  created_at: string;
}

interface EventCompactionRow extends EventRow {
  event_rowid: number;
}

interface EventCompactionStats {
  event_count: number;
  char_count: number;
  max_rowid: number;
}

interface CheckpointRow {
  checkpoint_id: string;
  session_id: string;
  run_id: string | null;
  org_id: string;
  seq: number;
  snapshot_json: string;
  summary: string | null;
  artifact_refs_json: string;
  created_at: string;
}

interface CandidateRow {
  id: string;
  org_id: string;
  project_id: string | null;
  pod_id: string | null;
  session_id: string | null;
  run_id: string | null;
  source_type: string;
  source_id: string;
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  retrieval_text: string | null;
  entity_refs_json: string;
  domains_json: string;
  confidence_score: number;
  evidence_json: string;
  status: MemoryCandidateStatus;
  promoted_node_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface ContextUpdateMemoryRow {
  id: string;
  agent_id: string;
  timestamp: string;
  pod_id?: string | null;
  project_id?: string | null;
  type: string;
  scope: string;
  summary: string;
  details: string;
  artifacts_json: string;
  status: string;
  source?: string | null;
}

interface AgentRunRollupMetadata {
  policy: AgentMemoryRollupPolicy;
  runKind?: AgentRunKind;
  sideEffectMode?: AgentSideEffectMode;
  realPrCreated?: boolean;
  stubbedSystems: string[];
  verificationStatus?: string;
  promotionIntent?: AgentPromotionIntent;
  learningSummary?: string;
  learningDetails?: string;
  prUrl?: string;
  warnings?: unknown;
  errors?: unknown;
  finalState?: JsonRecord;
}

interface PromotionGateResult {
  allow: boolean;
  policy: AgentMemoryRollupPolicy;
  reasons: string[];
}

type ExtractionKind = "deterministic" | "llm";
type ConfidenceLabel = "high" | "medium" | "low" | "junk";

interface AgentSessionSeed {
  type: KnowledgeNodeType;
  summary: string;
  details: string;
  domains: string[];
  artifactRefs: Artifact[];
  sourceRunIds: string[];
  primaryRunId?: string;
  evidenceRefs: string[];
  extractionKind: ExtractionKind;
  extractionModel: string;
  confidenceLabel?: ConfidenceLabel;
  durability?: ConfidenceLabel;
  confidenceScore: number;
}

interface LLMAgentSessionLearning {
  type?: unknown;
  domain?: unknown;
  domains?: unknown;
  summary?: unknown;
  details?: unknown;
  confidence?: unknown;
  evidence_refs?: unknown;
}

interface LLMAgentSessionExtractionResponse {
  learnings?: LLMAgentSessionLearning[];
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function asJsonRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function metadataSources(run: RunRow, session: SessionRow): JsonRecord[] {
  return [
    parseJson<JsonRecord>(run.metadata_json, {}),
    parseJson<JsonRecord>(session.metadata_json, {}),
    parseJson<JsonRecord>(session.working_state_json, {}),
  ];
}

function firstMetadataValue(sources: JsonRecord[], key: string): unknown {
  for (const source of sources) {
    if (hasOwn(source, key)) return source[key];
  }
  return undefined;
}

function firstEnumValue<T extends string>(sources: JsonRecord[], key: string, allowed: readonly T[]): T | undefined {
  const value = firstMetadataValue(sources, key);
  return isOneOf(value, allowed) ? value : undefined;
}

function firstStringValue(sources: JsonRecord[], key: string): string | undefined {
  const value = firstMetadataValue(sources, key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstStringValueForKeys(sources: JsonRecord[], keys: string[]): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      if (!hasOwn(source, key)) continue;
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function firstBooleanValue(sources: JsonRecord[], key: string): boolean | undefined {
  const value = firstMetadataValue(sources, key);
  return typeof value === "boolean" ? value : undefined;
}

function firstStringArrayValue(sources: JsonRecord[], key: string): string[] {
  const value = firstMetadataValue(sources, key);
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function firstRecordValue(sources: JsonRecord[], key: string): JsonRecord | undefined {
  return asJsonRecord(firstMetadataValue(sources, key));
}

function readAgentRunRollupMetadata(run: RunRow, session: SessionRow): AgentRunRollupMetadata {
  const sources = metadataSources(run, session);
  const finalState = firstRecordValue(sources, "final_state");
  return {
    policy: firstEnumValue<AgentMemoryRollupPolicy>(sources, "rollup_policy", ["none", "candidate_only", "auto_promote"]) ?? "candidate_only",
    runKind: firstEnumValue<AgentRunKind>(sources, "run_kind", ["real", "demo", "dry_run"]),
    sideEffectMode: firstEnumValue<AgentSideEffectMode>(sources, "side_effect_mode", ["real", "stubbed", "mixed"]),
    realPrCreated: firstBooleanValue(sources, "real_pr_created"),
    stubbedSystems: firstStringArrayValue(sources, "stubbed_systems"),
    verificationStatus: firstStringValue(sources, "verification_status"),
    promotionIntent: firstEnumValue<AgentPromotionIntent>(sources, "promotion_intent", ["audit_only", "durable_learning"]),
    learningSummary: firstStringValue(sources, "learning_summary"),
    learningDetails: firstStringValue(sources, "learning_details"),
    prUrl: firstStringValueForKeys(sources, ["pr_url", "pull_request_url", "github_pr_url", "merge_request_url"]),
    warnings: firstMetadataValue(sources, "warnings") ?? finalState?.warnings,
    errors: firstMetadataValue(sources, "errors") ?? finalState?.errors,
    finalState,
  };
}

function sessionMetadataSources(session: SessionRow): JsonRecord[] {
  return [
    parseJson<JsonRecord>(session.metadata_json, {}),
    parseJson<JsonRecord>(session.working_state_json, {}),
  ];
}

function readAgentSessionRollupPolicy(session: SessionRow): AgentMemoryRollupPolicy {
  return firstEnumValue<AgentMemoryRollupPolicy>(
    sessionMetadataSources(session),
    "rollup_policy",
    ["none", "candidate_only", "auto_promote"],
  ) ?? "candidate_only";
}

let _agentSessionExtractionPrompt: string | null = null;
function getAgentSessionExtractionPrompt(): string {
  if (!_agentSessionExtractionPrompt) {
    _agentSessionExtractionPrompt = fs.readFileSync(
      path.resolve(__dirname, AGENT_SESSION_LLM_PROMPT),
      "utf-8",
    );
  }
  return _agentSessionExtractionPrompt;
}

function isValidKnowledgeNodeType(type: unknown): type is KnowledgeNodeType {
  return type === "decision"
    || type === "pattern"
    || type === "anti_pattern"
    || type === "resolved_conflict"
    || type === "scope_insight";
}

function normalizeDomains(raw: unknown, fallback?: string | null): string[] {
  const values = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : typeof raw === "string" ? [raw] : [];
  const domains = values
    .map((value) => value.trim())
    .filter(Boolean);
  if (domains.length === 0 && fallback?.trim()) domains.push(fallback.trim());
  return [...new Set(domains.map((domain) => domain.toLowerCase()))];
}

function normalizeCandidateContentField(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizedCandidateContent(type: KnowledgeNodeType, summary: string, details: string): string {
  return JSON.stringify({
    type,
    summary: normalizeCandidateContentField(summary),
    details: normalizeCandidateContentField(details),
  });
}

function stableAgentSessionSourceId(sessionId: string, type: KnowledgeNodeType, summary: string, details: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(normalizedCandidateContent(type, summary, details))
    .digest("hex")
    .slice(0, 16);
  return `${sessionId}:${hash}`;
}

function clampText(text: string, max: number): string {
  return text.trim().replace(/\n{3,}/g, "\n\n").slice(0, max).trim();
}

function firstSentenceOrLine(text: string): string {
  const trimmed = text.trim();
  const sentence = trimmed.match(/^(.+?[.!?])(?:\s|$)/s)?.[1];
  return clampText(sentence ?? trimmed.split(/\n+/)[0] ?? trimmed, 500);
}

function hasLearningLength(summary: string, details: string): boolean {
  return summary.trim().length >= MIN_LEARNING_SUMMARY_LENGTH
    && details.trim().length >= MIN_LEARNING_DETAILS_LENGTH;
}

function confidenceScoreToLabel(score: number): ConfidenceLabel {
  if (score >= 0.85) return "high";
  if (score >= 0.7) return "medium";
  if (score >= 0.5) return "low";
  return "junk";
}

function llmConfidenceToScore(confidence: unknown): { label: "high" | "medium" | "low"; score: number } | null {
  if (confidence === "high") return { label: "high", score: 0.85 };
  if (confidence === "medium") return { label: "medium", score: 0.6 };
  if (confidence === "low") return { label: "low", score: 0.4 };
  return null;
}

function jsonRecordString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonRecordStringArray(record: JsonRecord, key: string): string[] {
  const value = record[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function artifactsFromRows(...rows: Array<{ artifacts_json?: string | null }>): Artifact[] {
  return rows.flatMap((row) => parseJson<Artifact[]>(row.artifacts_json, []));
}

function artifactRefsForRun(events: AgentRunEvent[]): Artifact[] {
  return events.flatMap((event) => event.artifact_refs);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))];
}

function primaryRunId(sourceRunIds: string[]): string | undefined {
  const unique = uniqueStrings(sourceRunIds);
  return unique.length === 1 ? unique[0] : undefined;
}

function extractContextUpdateIdFromPayload(payload: JsonRecord): string | undefined {
  const direct = firstStringValueForKeys([payload], ["context_update_id", "contextUpdateId", "update_id", "id"]);
  if (direct) return direct;
  const update = asJsonRecord(payload.update);
  return update ? firstStringValueForKeys([update], ["context_update_id", "contextUpdateId", "update_id", "id"]) : undefined;
}

function buildContextUpdateRunMap(runs: RunRow[], events: AgentRunEvent[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (contextUpdateId: string | undefined, runId: string | undefined) => {
    if (!contextUpdateId || !runId) return;
    const current = map.get(contextUpdateId) ?? [];
    if (!current.includes(runId)) current.push(runId);
    map.set(contextUpdateId, current);
  };
  for (const run of runs) add(run.context_update_id ?? undefined, run.run_id);
  for (const event of events) {
    if (event.event_type !== "context_update_submitted") continue;
    add(extractContextUpdateIdFromPayload(event.payload), event.run_id);
  }
  return map;
}

function sourceRunIdsForEvidenceRefs(
  evidenceRefs: string[],
  refToRunIds: Map<string, string[]>,
  knownRunIds: Set<string>,
): string[] {
  const out: string[] = [];
  for (const ref of evidenceRefs) {
    const mapped = refToRunIds.get(ref);
    if (mapped) out.push(...mapped);
    const runMatch = ref.match(/\brun:([A-Za-z0-9_-]+)/);
    if (runMatch?.[1] && knownRunIds.has(runMatch[1])) out.push(runMatch[1]);
    if (knownRunIds.has(ref)) out.push(ref);
  }
  return uniqueStrings(out);
}

function markerLearningFromText(text: string): string | undefined {
  const match = text.match(/durable learnings?\s*:\s*([\s\S]+)/i);
  if (!match?.[1]) return undefined;
  const candidate = match[1]
    .split(/\n\s*\n/)[0]
    .replace(/^\s*[-*]\s*/gm, "")
    .trim();
  return candidate.length >= MIN_LEARNING_SUMMARY_LENGTH ? candidate : undefined;
}

function extractLearningObjects(raw: unknown): Array<{ summary: string; details: string; type?: KnowledgeNodeType; domains?: string[] }> {
  if (!raw) return [];
  if (typeof raw === "string") {
    return [{ summary: firstSentenceOrLine(raw), details: raw }];
  }
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => extractLearningObjects(item));
  }
  const record = asJsonRecord(raw);
  if (!record) return [];
  const summary =
    jsonRecordString(record, "summary")
    ?? jsonRecordString(record, "learning_summary")
    ?? jsonRecordString(record, "decision")
    ?? jsonRecordString(record, "title");
  const details =
    jsonRecordString(record, "details")
    ?? jsonRecordString(record, "learning_details")
    ?? jsonRecordString(record, "rationale")
    ?? jsonRecordString(record, "description")
    ?? summary;
  const type = isValidKnowledgeNodeType(record.type) ? record.type : undefined;
  const domains = normalizeDomains(record.domain ?? record.domains);
  return summary && details ? [{ summary, details, type, domains }] : [];
}

function loadContextUpdateRows(
  orgId: string,
  contextUpdateIds: string[],
): {
  podUpdates: ContextUpdateMemoryRow[];
  projectUpdates: ContextUpdateMemoryRow[];
} {
  const ids = uniqueStrings(contextUpdateIds);
  if (ids.length === 0) return { podUpdates: [], projectUpdates: [] };
  const placeholders = ids.map(() => "?").join(",");
  const podUpdates = db
    .prepare(
      `SELECT id, agent_id, timestamp, pod_id, NULL AS project_id, type, scope, summary, details, artifacts_json, status, source
       FROM context_updates
       WHERE org_id = ? AND id IN (${placeholders}) AND retracted_at IS NULL`,
    )
    .all(orgId, ...ids) as unknown as ContextUpdateMemoryRow[];
  const projectUpdates = db
    .prepare(
      `SELECT id, agent_id, timestamp, NULL AS pod_id, project_id, type, scope, summary, details, artifacts_json, status, source
       FROM project_context_updates
       WHERE org_id = ? AND id IN (${placeholders}) AND retracted_at IS NULL`,
    )
    .all(orgId, ...ids) as unknown as ContextUpdateMemoryRow[];
  return { podUpdates, projectUpdates };
}

function buildSessionEvidenceRefs(input: {
  runs: RunRow[];
  events: AgentRunEvent[];
  checkpoints: AgentCheckpoint[];
  contextUpdateRunMap: Map<string, string[]>;
}): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const run of input.runs) {
    refs.set(`run:${run.run_id}`, [run.run_id]);
    if (run.context_update_id) refs.set(`context_update:${run.context_update_id}`, [run.run_id]);
  }
  for (const event of input.events) {
    refs.set(`event:${event.id}`, [event.run_id]);
    refs.set(`event:${event.run_id}:${event.seq}`, [event.run_id]);
    const contextUpdateId = event.event_type === "context_update_submitted"
      ? extractContextUpdateIdFromPayload(event.payload)
      : undefined;
    if (contextUpdateId) refs.set(`context_update:${contextUpdateId}`, uniqueStrings([...(refs.get(`context_update:${contextUpdateId}`) ?? []), event.run_id]));
  }
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.run_id) refs.set(`checkpoint:${checkpoint.checkpoint_id}`, [checkpoint.run_id]);
  }
  for (const [contextUpdateId, runIds] of input.contextUpdateRunMap) {
    refs.set(`context_update:${contextUpdateId}`, runIds);
    refs.set(`project_context_update:${contextUpdateId}`, runIds);
  }
  return refs;
}

function seedFromLearningText(input: {
  type?: KnowledgeNodeType;
  summary: string;
  details: string;
  domains: string[];
  artifactRefs?: Artifact[];
  sourceRunIds?: string[];
  evidenceRefs: string[];
}): AgentSessionSeed | null {
  const summary = clampText(input.summary, 500);
  const details = clampText(input.details, 4000);
  if (!hasLearningLength(summary, details)) return null;
  const type = input.type ?? candidateType(summary, details);
  const sourceRunIds = uniqueStrings(input.sourceRunIds ?? []);
  return {
    type,
    summary,
    details,
    domains: input.domains.length > 0 ? input.domains : ["agent-session"],
    artifactRefs: input.artifactRefs ?? [],
    sourceRunIds,
    primaryRunId: primaryRunId(sourceRunIds),
    evidenceRefs: uniqueStrings(input.evidenceRefs),
    extractionKind: "deterministic",
    extractionModel: DETERMINISTIC_AGENT_SESSION_MODEL,
    confidenceScore: 0.7,
  };
}

function extractDeterministicAgentSessionSeeds(input: {
  session: SessionRow;
  runs: RunRow[];
  events: AgentRunEvent[];
  checkpoints: AgentCheckpoint[];
  podUpdates: ContextUpdateMemoryRow[];
  projectUpdates: ContextUpdateMemoryRow[];
  contextUpdateRunMap: Map<string, string[]>;
}): AgentSessionSeed[] {
  const seeds: AgentSessionSeed[] = [];
  const eventsByRun = new Map<string, AgentRunEvent[]>();
  for (const event of input.events) {
    const current = eventsByRun.get(event.run_id) ?? [];
    current.push(event);
    eventsByRun.set(event.run_id, current);
  }

  for (const update of [...input.podUpdates, ...input.projectUpdates]) {
    if (update.type !== "decision" && update.type !== "spec_change") continue;
    const sourceRunIds = input.contextUpdateRunMap.get(update.id) ?? [];
    const seed = seedFromLearningText({
      type: update.type === "decision" ? "decision" : "scope_insight",
      summary: update.summary,
      details: update.details || update.summary,
      domains: normalizeDomains(update.scope),
      artifactRefs: artifactsFromRows(update),
      sourceRunIds,
      evidenceRefs: [`${update.project_id ? "project_context_update" : "context_update"}:${update.id}`],
    });
    if (seed) seeds.push(seed);
  }

  for (const run of input.runs) {
    const metadata = readAgentRunRollupMetadata(run, input.session);
    if (metadata.policy === "none") continue;
    const runEvents = eventsByRun.get(run.run_id) ?? [];
    const domains = normalizeDomains([run.scope, run.project_id, "agent-session"]);
    if (metadata.learningSummary || metadata.learningDetails) {
      const summary = metadata.learningSummary ?? firstSentenceOrLine(metadata.learningDetails ?? "");
      const details = metadata.learningDetails ?? [metadata.learningSummary, run.final_output].filter(Boolean).join("\n\n");
      const seed = seedFromLearningText({
        summary,
        details,
        domains,
        artifactRefs: artifactRefsForRun(runEvents),
        sourceRunIds: [run.run_id],
        evidenceRefs: [`run:${run.run_id}`, "metadata:learning_summary"],
      });
      if (seed) seeds.push(seed);
    }

    const marker = run.final_output ? markerLearningFromText(run.final_output) : undefined;
    if (marker) {
      const seed = seedFromLearningText({
        summary: firstSentenceOrLine(marker),
        details: marker.length >= MIN_LEARNING_DETAILS_LENGTH ? marker : `${marker}\n\n${run.final_output ?? ""}`,
        domains,
        artifactRefs: artifactRefsForRun(runEvents),
        sourceRunIds: [run.run_id],
        evidenceRefs: [`run:${run.run_id}`, "final_output:durable_learning"],
      });
      if (seed) seeds.push(seed);
    }
  }

  const sessionSources = sessionMetadataSources(input.session);
  const sessionSummary = firstStringValue(sessionSources, "learning_summary");
  const sessionDetails = firstStringValue(sessionSources, "learning_details");
  if (sessionSummary || sessionDetails) {
    const completedRunIds = input.runs.filter((run) => run.status === "completed").map((run) => run.run_id);
    const seed = seedFromLearningText({
      summary: sessionSummary ?? firstSentenceOrLine(sessionDetails ?? ""),
      details: sessionDetails ?? sessionSummary ?? "",
      domains: normalizeDomains([input.session.scope, input.session.project_id, "agent-session"]),
      sourceRunIds: completedRunIds.length === 1 ? completedRunIds : [],
      evidenceRefs: ["session:metadata:learning_summary"],
    });
    if (seed) seeds.push(seed);
  }

  for (const checkpoint of input.checkpoints) {
    const records = [
      ...extractLearningObjects(checkpoint.snapshot.durable_learning),
      ...extractLearningObjects(checkpoint.snapshot.durable_learnings),
      ...extractLearningObjects(checkpoint.snapshot.learning_summary),
      ...extractLearningObjects(checkpoint.snapshot.learning),
      ...extractLearningObjects(checkpoint.snapshot.decision),
      ...extractLearningObjects(checkpoint.snapshot.decisions),
      ...extractLearningObjects(checkpoint.snapshot.spec_decision),
    ];
    const summarySignal: Array<{ summary: string; details: string; type?: KnowledgeNodeType; domains?: string[] }> = checkpoint.summary && /\b(decision|decided|durable learning|spec)\b/i.test(checkpoint.summary)
      ? [{ summary: checkpoint.summary, details: JSON.stringify(checkpoint.snapshot).slice(0, 4000) }]
      : [];
    for (const item of [...records, ...summarySignal]) {
      const seed = seedFromLearningText({
        type: item.type,
        summary: item.summary,
        details: item.details,
        domains: item.domains && item.domains.length > 0
          ? item.domains
          : normalizeDomains([input.session.scope, input.session.project_id, "agent-session"]),
        artifactRefs: checkpoint.artifact_refs,
        sourceRunIds: checkpoint.run_id ? [checkpoint.run_id] : [],
        evidenceRefs: [`checkpoint:${checkpoint.checkpoint_id}`],
      });
      if (seed) seeds.push(seed);
    }
  }

  return seeds;
}

async function scoreDeterministicSeeds(seeds: AgentSessionSeed[]): Promise<AgentSessionSeed[]> {
  const classifierItems: PodLearning[] = seeds.map((seed) => ({
    type: "pattern",
    summary: seed.summary,
    details: seed.details,
    scope: seed.domains[0] ?? "agent-session",
  }));
  const scores = await classifyDecisionDurability(classifierItems);
  return seeds.flatMap((seed, index) => {
    const score = scores.get(index) ?? 0.7;
    const label = confidenceScoreToLabel(score);
    if (label === "junk") return [];
    return [{
      ...seed,
      confidenceScore: score,
      confidenceLabel: label,
      durability: label,
    }];
  });
}

function buildAgentSessionLLMPromptPacket(input: {
  session: SessionRow;
  runs: RunRow[];
  events: AgentRunEvent[];
  checkpoints: AgentCheckpoint[];
  podUpdates: ContextUpdateMemoryRow[];
  projectUpdates: ContextUpdateMemoryRow[];
}): string {
  const packet = {
    session: {
      session_id: input.session.session_id,
      project_id: input.session.project_id,
      pod_id: input.session.pod_id,
      scope: input.session.scope,
      agent_id: input.session.agent_id,
      status: input.session.status,
      goal: input.session.goal,
      current_task: input.session.current_task,
      working_state: parseJson<JsonRecord>(input.session.working_state_json, {}),
      metadata: parseJson<JsonRecord>(input.session.metadata_json, {}),
      compacted_summary: input.session.compacted_summary,
    },
    runs: input.runs.map((run) => ({
      ref: `run:${run.run_id}`,
      run_id: run.run_id,
      status: run.status,
      input_prompt: run.input_prompt,
      model: run.model,
      provider: run.provider,
      metadata: parseJson<JsonRecord>(run.metadata_json, {}),
      context_update_id: run.context_update_id,
      final_output: run.final_output,
      compacted_summary: run.compacted_summary,
      error_message: run.error_message,
    })),
    context_updates: input.podUpdates.map((update) => ({
      ref: `context_update:${update.id}`,
      type: update.type,
      scope: update.scope,
      summary: update.summary,
      details: update.details,
      status: update.status,
      source: update.source,
    })),
    project_context_updates: input.projectUpdates.map((update) => ({
      ref: `project_context_update:${update.id}`,
      type: update.type,
      scope: update.scope,
      summary: update.summary,
      details: update.details,
      status: update.status,
      source: update.source,
    })),
    checkpoints: input.checkpoints.slice(-20).map((checkpoint) => ({
      ref: `checkpoint:${checkpoint.checkpoint_id}`,
      run_ref: checkpoint.run_id ? `run:${checkpoint.run_id}` : null,
      summary: checkpoint.summary,
      snapshot: checkpoint.snapshot,
      artifact_refs: checkpoint.artifact_refs,
    })),
    events: input.events.slice(-60).map((event) => ({
      ref: `event:${event.id}`,
      run_ref: `run:${event.run_id}`,
      seq: event.seq,
      event_type: event.event_type,
      summary: event.summary,
      payload: event.payload,
      artifact_refs: event.artifact_refs,
    })),
  };
  return JSON.stringify(packet, null, 2);
}

async function extractLLMAgentSessionSeeds(input: {
  session: SessionRow;
  runs: RunRow[];
  events: AgentRunEvent[];
  checkpoints: AgentCheckpoint[];
  podUpdates: ContextUpdateMemoryRow[];
  projectUpdates: ContextUpdateMemoryRow[];
  refToRunIds: Map<string, string[]>;
  existingContent: Set<string>;
}): Promise<AgentSessionSeed[]> {
  if (!isLLMAvailable()) return [];
  const response = await callLLMJSON<LLMAgentSessionExtractionResponse | LLMAgentSessionLearning[]>({
    model: MODELS.fast,
    system: getAgentSessionExtractionPrompt(),
    prompt: buildAgentSessionLLMPromptPacket(input),
    maxTokens: 2048,
  });
  const rawLearnings = Array.isArray(response) ? response : response?.learnings;
  if (!Array.isArray(rawLearnings)) return [];

  const knownRunIds = new Set(input.runs.map((run) => run.run_id));
  const seeds: AgentSessionSeed[] = [];
  for (const raw of rawLearnings) {
    if (!isValidKnowledgeNodeType(raw.type)) continue;
    const domains = normalizeDomains(raw.domain ?? raw.domains);
    if (domains.length === 0) continue;
    if (typeof raw.summary !== "string" || typeof raw.details !== "string") continue;
    const summary = clampText(raw.summary, 500);
    const details = clampText(raw.details, 4000);
    if (!hasLearningLength(summary, details)) continue;
    if (!Array.isArray(raw.evidence_refs)) continue;
    const evidenceRefs = raw.evidence_refs
      .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
      .map((ref) => ref.trim());
    if (evidenceRefs.length === 0) continue;
    const confidence = llmConfidenceToScore(raw.confidence);
    if (!confidence) continue;
    const contentKey = normalizedCandidateContent(raw.type, summary, details);
    if (input.existingContent.has(contentKey)) continue;
    input.existingContent.add(contentKey);
    const sourceRunIds = sourceRunIdsForEvidenceRefs(evidenceRefs, input.refToRunIds, knownRunIds);
    seeds.push({
      type: raw.type,
      summary,
      details,
      domains,
      artifactRefs: [],
      sourceRunIds,
      primaryRunId: primaryRunId(sourceRunIds),
      evidenceRefs,
      extractionKind: "llm",
      extractionModel: MODELS.fast,
      confidenceLabel: confidence.label,
      confidenceScore: confidence.score,
    });
  }
  return seeds;
}

function toSession(row: SessionRow): AgentSession {
  return {
    session_id: row.session_id,
    org_id: row.org_id,
    project_id: row.project_id,
    pod_id: row.pod_id,
    scope: row.scope,
    agent_id: row.agent_id,
    status: row.status,
    goal: row.goal,
    current_task: row.current_task,
    working_state: parseJson<JsonRecord>(row.working_state_json, {}),
    compacted_summary: row.compacted_summary,
    metadata: parseJson<JsonRecord>(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ended_at: row.ended_at,
  };
}

function toRun(row: RunRow): AgentRun {
  return {
    run_id: row.run_id,
    session_id: row.session_id,
    org_id: row.org_id,
    project_id: row.project_id,
    pod_id: row.pod_id,
    scope: row.scope,
    agent_id: row.agent_id,
    status: row.status,
    input_prompt: row.input_prompt,
    model: row.model,
    provider: row.provider,
    metadata: parseJson<JsonRecord>(row.metadata_json, {}),
    token_input_count: row.token_input_count,
    token_output_count: row.token_output_count,
    total_cost_usd: row.total_cost_usd,
    error_message: row.error_message,
    final_output: row.final_output,
    context_update_id: row.context_update_id,
    compacted_summary: row.compacted_summary,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

function toEvent(row: EventRow): AgentRunEvent {
  return {
    id: row.id,
    run_id: row.run_id,
    session_id: row.session_id,
    org_id: row.org_id,
    seq: row.seq,
    event_type: row.event_type,
    payload: parseJson<JsonRecord>(row.payload_json, {}),
    summary: row.summary,
    artifact_refs: parseJson<Artifact[]>(row.artifact_refs_json, []),
    token_count: row.token_count,
    created_at: row.created_at,
  };
}

function toCheckpoint(row: CheckpointRow): AgentCheckpoint {
  return {
    checkpoint_id: row.checkpoint_id,
    session_id: row.session_id,
    run_id: row.run_id,
    org_id: row.org_id,
    seq: row.seq,
    snapshot: parseJson<JsonRecord>(row.snapshot_json, {}),
    summary: row.summary,
    artifact_refs: parseJson<Artifact[]>(row.artifact_refs_json, []),
    created_at: row.created_at,
  };
}

function toCandidate(row: CandidateRow): MemoryCandidate {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    pod_id: row.pod_id,
    session_id: row.session_id,
    run_id: row.run_id,
    source_type: row.source_type,
    source_id: row.source_id,
    type: row.type,
    summary: row.summary,
    details: row.details,
    retrieval_text: row.retrieval_text,
    entity_refs: parseJson<MemoryEntityRef[]>(row.entity_refs_json, []),
    domains: parseJson<string[]>(row.domains_json, []),
    confidence_score: row.confidence_score,
    evidence: parseJson<JsonRecord>(row.evidence_json, {}),
    status: row.status,
    promoted_node_id: row.promoted_node_id,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
  };
}

function getSessionRow(orgId: string, sessionId: string): SessionRow | null {
  const row = db
    .prepare("SELECT * FROM agent_sessions WHERE org_id = ? AND session_id = ?")
    .get(orgId, sessionId) as unknown as SessionRow | undefined;
  return row ?? null;
}

function getRunRow(orgId: string, runId: string): RunRow | null {
  const row = db
    .prepare("SELECT * FROM agent_runs WHERE org_id = ? AND run_id = ?")
    .get(orgId, runId) as unknown as RunRow | undefined;
  return row ?? null;
}

function loadPod(orgId: string, podId: string | null | undefined):
  | { pod_id: string; name: string; project_id: string | null }
  | null {
  if (!podId) return null;
  const row = db
    .prepare("SELECT pod_id, name, project_id FROM pods WHERE pod_id = ? AND org_id = ?")
    .get(podId, orgId) as { pod_id: string; name: string; project_id: string | null } | undefined;
  return row ?? null;
}

function loadProject(orgId: string, projectId: string | null | undefined):
  | { project_id: string; name: string }
  | null {
  if (!projectId) return null;
  const row = db
    .prepare("SELECT project_id, name FROM projects WHERE project_id = ? AND org_id = ?")
    .get(projectId, orgId) as { project_id: string; name: string } | undefined;
  return row ?? null;
}

export function createAgentSession(input: {
  orgId: string;
  project_id?: string | null;
  pod_id?: string | null;
  scope?: string | null;
  agent_id: string;
  goal?: string | null;
  current_task?: string | null;
  working_state?: JsonRecord;
  metadata?: JsonRecord;
}): AgentSession | null {
  const pod = loadPod(input.orgId, input.pod_id);
  if (input.pod_id && !pod) return null;
  const projectId = input.project_id ?? pod?.project_id ?? null;
  if (projectId && !loadProject(input.orgId, projectId)) return null;
  const now = new Date().toISOString();
  const sessionId = id("as");
  db.prepare(
    `INSERT INTO agent_sessions
       (session_id, org_id, project_id, pod_id, scope, agent_id, status, goal, current_task,
        working_state_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    input.orgId,
    projectId,
    input.pod_id ?? null,
    input.scope ?? null,
    input.agent_id,
    input.goal ?? null,
    input.current_task ?? null,
    JSON.stringify(input.working_state ?? {}),
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );
  const row = getSessionRow(input.orgId, sessionId);
  return row ? toSession(row) : null;
}

export function getAgentSession(orgId: string, sessionId: string): AgentSession | null {
  const row = getSessionRow(orgId, sessionId);
  return row ? toSession(row) : null;
}

export function updateAgentSessionWorkingState(
  orgId: string,
  sessionId: string,
  input: { working_state: JsonRecord; merge?: boolean; current_task?: string | null; status?: AgentSession["status"] },
): AgentSession | null {
  const row = getSessionRow(orgId, sessionId);
  if (!row) return null;
  const current = parseJson<JsonRecord>(row.working_state_json, {});
  const next = input.merge === false ? input.working_state : { ...current, ...input.working_state };
  const now = new Date().toISOString();
  const hasCurrentTask = Object.prototype.hasOwnProperty.call(input, "current_task");
  const currentTask = hasCurrentTask ? input.current_task ?? null : row.current_task;
  db.prepare(
    `UPDATE agent_sessions
     SET working_state_json = ?, current_task = ?, status = COALESCE(?, status), updated_at = ?
     WHERE org_id = ? AND session_id = ?`,
  ).run(JSON.stringify(next), currentTask, input.status ?? null, now, orgId, sessionId);
  const updated = getSessionRow(orgId, sessionId);
  return updated ? toSession(updated) : null;
}

export function createAgentRun(orgId: string, sessionId: string, input: {
  input_prompt?: string | null;
  model?: string | null;
  provider?: string | null;
  metadata?: JsonRecord;
}): AgentRun | null {
  const sessionRow = getSessionRow(orgId, sessionId);
  if (!sessionRow) return null;
  const now = new Date().toISOString();
  const runId = id("ar");
  db.prepare(
    `INSERT INTO agent_runs
       (run_id, session_id, org_id, project_id, pod_id, scope, agent_id, status, input_prompt, model, provider, metadata_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    sessionId,
    orgId,
    sessionRow.project_id,
    sessionRow.pod_id,
    sessionRow.scope,
    sessionRow.agent_id,
    input.input_prompt ?? null,
    input.model ?? null,
    input.provider ?? null,
    JSON.stringify(input.metadata ?? {}),
    now,
  );
  db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ? AND org_id = ?").run(now, sessionId, orgId);
  const row = getRunRow(orgId, runId);
  return row ? toRun(row) : null;
}

function nextRunEventSeq(runId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM agent_run_events WHERE run_id = ?")
    .get(runId) as { next_seq: number };
  return row.next_seq;
}

export function appendAgentRunEvent(orgId: string, runId: string, input: {
  event_type: AgentRunEventType;
  payload?: JsonRecord;
  summary?: string | null;
  artifact_refs?: Artifact[];
  token_count?: number;
  expected_seq?: number;
  created_at?: string;
}): AgentRunEvent | null {
  return withImmediateTransaction(() => {
    const run = getRunRow(orgId, runId);
    if (!run) return null;
    if (run.status !== "running") throw new AgentRunNotAppendableError(run.status);

    const nextSeq = nextRunEventSeq(runId);
    if (input.expected_seq !== undefined && input.expected_seq !== nextSeq) {
      throw new AgentMemorySequenceError(`Expected event seq ${input.expected_seq}, next seq is ${nextSeq}`, nextSeq);
    }
    const eventId = id("are");
    const now = input.created_at ?? new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO agent_run_events
           (id, run_id, session_id, org_id, seq, event_type, payload_json, summary, artifact_refs_json, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        run.run_id,
        run.session_id,
        orgId,
        nextSeq,
        input.event_type,
        JSON.stringify(input.payload ?? {}),
        input.summary ?? null,
        JSON.stringify(input.artifact_refs ?? []),
        input.token_count ?? 0,
        now,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: agent_run_events.run_id, agent_run_events.seq")) {
        throw new AgentMemorySequenceError(`Expected event seq ${nextSeq}, next seq is ${nextSeq + 1}`, nextSeq + 1);
      }
      throw err;
    }
    db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ? AND org_id = ?").run(now, run.session_id, orgId);
    compactSessionIfNeeded(orgId, run.session_id, run.run_id);
    const row = db.prepare("SELECT * FROM agent_run_events WHERE id = ?").get(eventId) as unknown as EventRow;
    return toEvent(row);
  });
}

function nextCheckpointSeq(sessionId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM agent_checkpoints WHERE session_id = ?")
    .get(sessionId) as { next_seq: number };
  return row.next_seq;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createAgentCheckpoint(orgId: string, sessionId: string, input: {
  run_id?: string | null;
  snapshot: JsonRecord;
  summary?: string | null;
  artifact_refs?: Artifact[];
}): AgentCheckpoint | null {
  const session = getSessionRow(orgId, sessionId);
  if (!session) return null;
  if (input.run_id && !getRunRow(orgId, input.run_id)) return null;
  const now = new Date().toISOString();
  const checkpointId = id("acp");
  const seq = nextCheckpointSeq(sessionId);
  db.prepare(
    `INSERT INTO agent_checkpoints
       (checkpoint_id, session_id, run_id, org_id, seq, snapshot_json, summary, artifact_refs_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    checkpointId,
    sessionId,
    input.run_id ?? null,
    orgId,
    seq,
    JSON.stringify(input.snapshot),
    input.summary ?? null,
    JSON.stringify(input.artifact_refs ?? []),
    now,
  );
  db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ? AND org_id = ?").run(now, sessionId, orgId);
  const row = db.prepare("SELECT * FROM agent_checkpoints WHERE checkpoint_id = ?").get(checkpointId) as unknown as CheckpointRow;
  return toCheckpoint(row);
}

function compactSessionIfNeeded(orgId: string, sessionId: string, runId?: string): void {
  const session = getSessionRow(orgId, sessionId);
  if (!session) return;
  const eventThreshold = positiveIntFromEnv("AGENT_MEMORY_COMPACT_EVENT_THRESHOLD", 50);
  const charThreshold = positiveIntFromEnv("AGENT_MEMORY_COMPACT_CHAR_THRESHOLD", 12000);
  const lastCompactedRowid = session.last_compacted_event_rowid ?? 0;
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) AS event_count,
         COALESCE(SUM(LENGTH(COALESCE(summary, '')) + LENGTH(payload_json)), 0) AS char_count,
         COALESCE(MAX(rowid), ?) AS max_rowid
      FROM agent_run_events
      WHERE org_id = ? AND session_id = ? AND rowid > ? AND event_type != 'run_compacted'`,
    )
    .get(lastCompactedRowid, orgId, sessionId, lastCompactedRowid) as unknown as EventCompactionStats;
  if (stats.event_count < eventThreshold && stats.char_count < charThreshold) return;

  const rows = db
    .prepare(
      `SELECT rowid AS event_rowid, *
       FROM agent_run_events
       WHERE org_id = ?
         AND session_id = ?
         AND rowid > ?
         AND rowid <= ?
         AND event_type != 'run_compacted'
         AND (event_type IN ('model_output','file_change','checkpoint_created','context_update_submitted')
              OR summary IS NOT NULL)
       ORDER BY rowid DESC
       LIMIT 20`,
    )
    .all(orgId, sessionId, lastCompactedRowid, stats.max_rowid) as unknown as EventCompactionRow[];
  const durable = rows
    .reverse()
    .map((r) => `- #${r.seq} ${r.event_type}: ${r.summary ?? r.payload_json.slice(0, 160)}`);
  const prior = session.compacted_summary?.trim();
  const summary = [
    prior ? `Prior compacted memory:\n${prior.slice(-4000)}` : "",
    "Compacted agent session memory.",
    `Events compacted in this segment: ${stats.event_count}.`,
    `Compacted through event row: ${stats.max_rowid}.`,
    durable.length > 0 ? "Recent durable signals:\n" + durable.join("\n") : "",
  ].filter(Boolean).join("\n");
  const now = new Date().toISOString();
  db.prepare("UPDATE agent_sessions SET compacted_summary = ?, last_compacted_event_rowid = ?, updated_at = ? WHERE org_id = ? AND session_id = ?").run(
    summary,
    stats.max_rowid,
    now,
    orgId,
    sessionId,
  );
  if (runId) {
    db.prepare("UPDATE agent_runs SET compacted_summary = ? WHERE org_id = ? AND run_id = ?").run(
      summary,
      orgId,
      runId,
    );
    insertCompactionEvent(orgId, sessionId, runId, {
      summary,
      compactedThroughRowid: stats.max_rowid,
      eventCount: stats.event_count,
      createdAt: now,
    });
  }
}

function insertCompactionEvent(
  orgId: string,
  sessionId: string,
  runId: string,
  input: {
    summary: string;
    compactedThroughRowid: number;
    eventCount: number;
    createdAt: string;
  },
): void {
  const run = getRunRow(orgId, runId);
  if (!run || run.status !== "running") return;
  const nextSeq = nextRunEventSeq(runId);
  db.prepare(
    `INSERT INTO agent_run_events
       (id, run_id, session_id, org_id, seq, event_type, payload_json, summary, artifact_refs_json, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, 'run_compacted', ?, ?, '[]', 0, ?)`,
  ).run(
    id("are"),
    runId,
    sessionId,
    orgId,
    nextSeq,
    JSON.stringify({
      compacted_through_event_rowid: input.compactedThroughRowid,
      event_count: input.eventCount,
    }),
    `Compacted ${input.eventCount} event(s) through row ${input.compactedThroughRowid}.`,
    input.createdAt,
  );
}

export async function endAgentRun(orgId: string, runId: string, input: {
  status: AgentRunStatus;
  final_output?: string | null;
  error_message?: string | null;
  token_input_count?: number;
  token_output_count?: number;
  total_cost_usd?: number;
  context_update_id?: string | null;
  compacted_summary?: string | null;
}): Promise<AgentRun | null> {
  const run = getRunRow(orgId, runId);
  if (!run) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agent_runs
     SET status = ?, final_output = ?, error_message = ?, token_input_count = ?, token_output_count = ?,
         total_cost_usd = ?, context_update_id = ?, compacted_summary = COALESCE(?, compacted_summary), ended_at = ?
     WHERE org_id = ? AND run_id = ?`,
  ).run(
    input.status,
    input.final_output ?? run.final_output,
    input.error_message ?? run.error_message,
    input.token_input_count ?? run.token_input_count,
    input.token_output_count ?? run.token_output_count,
    input.total_cost_usd ?? run.total_cost_usd,
    input.context_update_id ?? run.context_update_id,
    input.compacted_summary ?? null,
    now,
    orgId,
    runId,
  );
  db.prepare("UPDATE agent_sessions SET updated_at = ? WHERE org_id = ? AND session_id = ?").run(now, orgId, run.session_id);
  const updated = getRunRow(orgId, runId);
  return updated ? toRun(updated) : null;
}

function latestRun(orgId: string, sessionId: string): AgentRun | undefined {
  const row = db
    .prepare("SELECT * FROM agent_runs WHERE org_id = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(orgId, sessionId) as unknown as RunRow | undefined;
  return row ? toRun(row) : undefined;
}

export function getAgentSessionTimeline(orgId: string, sessionId: string): {
  session: AgentSession;
  runs: AgentRun[];
  events: AgentRunEvent[];
  checkpoints: AgentCheckpoint[];
} | null {
  const sessionRow = getSessionRow(orgId, sessionId);
  if (!sessionRow) return null;
  const runs = (db
    .prepare("SELECT * FROM agent_runs WHERE org_id = ? AND session_id = ? ORDER BY started_at ASC")
    .all(orgId, sessionId) as unknown as RunRow[]).map(toRun);
  const events = (db
    .prepare("SELECT * FROM agent_run_events WHERE org_id = ? AND session_id = ? ORDER BY created_at ASC, seq ASC")
    .all(orgId, sessionId) as unknown as EventRow[]).map(toEvent);
  const checkpoints = (db
    .prepare("SELECT * FROM agent_checkpoints WHERE org_id = ? AND session_id = ? ORDER BY seq ASC")
    .all(orgId, sessionId) as unknown as CheckpointRow[]).map(toCheckpoint);
  return { session: toSession(sessionRow), runs, events, checkpoints };
}

export function listMemoryCandidates(orgId: string, filters: {
  session_id?: string;
  project_id?: string;
  status?: MemoryCandidateStatus;
  } = {}): MemoryCandidate[] {
  const clauses = ["org_id = ?"];
  const args: string[] = [orgId];
  if (filters.session_id) {
    clauses.push("session_id = ?");
    args.push(filters.session_id);
  }
  if (filters.project_id) {
    clauses.push("project_id = ?");
    args.push(filters.project_id);
  }
  if (filters.status) {
    clauses.push("status = ?");
    args.push(filters.status);
  }
  const rows = db
    .prepare(`SELECT * FROM memory_candidates WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`)
    .all(...args) as unknown as CandidateRow[];
  return rows.map(toCandidate);
}

export async function assembleAgentResumeContext(
  orgId: string,
  sessionId: string,
  eventLimit = DEFAULT_RECENT_EVENT_LIMIT,
): Promise<AgentResumeContext | null> {
  const sessionRow = getSessionRow(orgId, sessionId);
  if (!sessionRow) return null;
  const session = toSession(sessionRow);
  const latestCheckpointRow = db
    .prepare("SELECT * FROM agent_checkpoints WHERE org_id = ? AND session_id = ? ORDER BY seq DESC LIMIT 1")
    .get(orgId, sessionId) as unknown as CheckpointRow | undefined;
  const eventRows = db
    .prepare("SELECT * FROM agent_run_events WHERE org_id = ? AND session_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?")
    .all(orgId, sessionId, eventLimit) as unknown as EventRow[];
  const livingDoc = session.pod_id
    ? db.prepare("SELECT markdown FROM living_docs WHERE pod_id = ? AND org_id = ?").get(session.pod_id, orgId) as { markdown: string } | undefined
    : undefined;
  const decisions = session.pod_id && session.scope
    ? db.prepare(
        `SELECT id, summary, timestamp, agent_id
         FROM context_updates
         WHERE org_id = ? AND pod_id = ? AND scope = ? AND type = 'decision' AND retracted_at IS NULL
         ORDER BY timestamp DESC LIMIT 10`,
      ).all(orgId, session.pod_id, session.scope) as Array<{ id: string; summary: string; timestamp: string; agent_id: string }>
    : [];
  const conflicts = session.pod_id
    ? db.prepare(
        `SELECT id, summary, status, severity, created_at
         FROM conflicts
         WHERE org_id = ? AND pod_id = ? AND status != 'dismissed'
         ORDER BY created_at DESC LIMIT 10`,
      ).all(orgId, session.pod_id) as Array<{ id: string; summary: string; status: string; severity: string; created_at: string }>
    : [];
  const projectMemory = session.project_id
    ? listMemoryCandidates(orgId, { project_id: session.project_id })
        .filter((candidate) => candidate.status === "promoted" || candidate.status === "auto_promoted")
        .slice(0, 10)
    : [];

  let orgKnowledge: AgentResumeContext["org_knowledge"] = [];
  try {
    const query = [
      session.goal,
      session.current_task,
      session.scope,
      ...(eventRows.map((e) => e.summary).filter(Boolean) as string[]),
    ].filter(Boolean).join(" ");
    const kg = queryKnowledge(orgId, {
      filters: {
        ...(session.project_id ? { include_project_id: session.project_id } : {}),
        ...(session.scope ? { domains: [session.scope] } : {}),
      },
      query_text: query || undefined,
      max_tokens: 1000,
      include_details: true,
      limit: 8,
    });
    orgKnowledge = kg.nodes.map((n) => ({
      id: n.id,
      summary: n.summary,
      details: n.details,
      confidence_score: n.confidence_score,
    }));
  } catch {
    orgKnowledge = [];
  }

  return {
    session,
    latest_run: latestRun(orgId, sessionId),
    working_state: session.working_state,
    latest_checkpoint: latestCheckpointRow ? toCheckpoint(latestCheckpointRow) : undefined,
    compacted_summary: session.compacted_summary,
    recent_events: eventRows.reverse().map(toEvent),
    pod_living_doc: livingDoc?.markdown ?? null,
    same_scope_decisions: decisions,
    same_scope_conflicts: conflicts,
    project_memory: projectMemory,
    org_knowledge: orgKnowledge,
  };
}

function candidateType(summary: string, details: string): KnowledgeNodeType {
  const text = `${summary} ${details}`.toLowerCase();
  if (text.includes("avoid") || text.includes("regression") || text.includes("risk")) return "anti_pattern";
  if (text.includes("conflict") || text.includes("resolved")) return "resolved_conflict";
  if (text.includes("decision") || text.includes("decided") || text.includes("chose")) return "decision";
  if (text.includes("pattern") || text.includes("implemented") || text.includes("fixed")) return "pattern";
  return "scope_insight";
}

function hasArtifactEvidence(events: AgentRunEvent[], artifactRefs: Artifact[]): boolean {
  return artifactRefs.length > 0 || events.some((e) => e.event_type === "file_change");
}

function artifactLooksLikePr(artifact: Artifact): boolean {
  const type = artifact.type.toLowerCase();
  return type === "pr"
    || type === "pull_request"
    || type === "github_pr"
    || type === "merge_request"
    || type.includes("pull_request")
    || type.includes("github_pr")
    || type.includes("merge_request");
}

function urlLooksLikeCodeReview(raw: string): boolean {
  try {
    const url = new URL(raw);
    return /\/pull\/\d+(?:\/)?$/i.test(url.pathname) || /\/merge_requests\/\d+(?:\/)?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function artifactLooksLikeCodeChange(artifact: Artifact): boolean {
  const type = artifact.type.toLowerCase();
  return Boolean(artifact.path)
    || type === "file"
    || type === "diff"
    || type === "patch"
    || artifactLooksLikePr(artifact)
    || Boolean(artifact.url && urlLooksLikeCodeReview(artifact.url));
}

function isCodeChangeWorkflow(events: AgentRunEvent[], artifactRefs: Artifact[]): boolean {
  return events.some((e) => e.event_type === "file_change") || artifactRefs.some(artifactLooksLikeCodeChange);
}

function isPlaceholderUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return host === "example.invalid"
      || host === "example.com"
      || host === "example.org"
      || host === "example.net"
      || host === "localhost"
      || host === "127.0.0.1"
      || host === "0.0.0.0"
      || host.endsWith(".invalid")
      || host.endsWith(".example");
  } catch {
    return true;
  }
}

function stringFromRecord(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findPrUrl(metadata: AgentRunRollupMetadata, artifactRefs: Artifact[], events: AgentRunEvent[]): string | undefined {
  if (metadata.prUrl) return metadata.prUrl;
  for (const artifact of artifactRefs) {
    if (artifact.url && (artifactLooksLikePr(artifact) || urlLooksLikeCodeReview(artifact.url))) return artifact.url;
  }
  const keys = ["pr_url", "pull_request_url", "github_pr_url", "merge_request_url"];
  for (const event of events) {
    for (const key of keys) {
      const value = stringFromRecord(event.payload, key);
      if (value) return value;
    }
  }
  return undefined;
}

function isNonEmptySignal(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "boolean") return value;
  return true;
}

function hasFinalWarningsOrErrors(run: RunRow, metadata: AgentRunRollupMetadata): boolean {
  if (run.error_message?.trim()) return true;
  const verification = metadata.verificationStatus?.toLowerCase();
  if (verification && (verification.includes("fail") || verification.includes("error") || verification.includes("warning"))) {
    return true;
  }
  if (isNonEmptySignal(metadata.warnings) || isNonEmptySignal(metadata.errors)) return true;
  if (isNonEmptySignal(metadata.finalState?.warnings) || isNonEmptySignal(metadata.finalState?.errors)) return true;
  return false;
}

function hasRealContextUpdate(run: RunRow): boolean {
  const contextUpdateId = run.context_update_id?.trim();
  if (!contextUpdateId) return false;
  const normalized = contextUpdateId.toLowerCase();
  return normalized !== "demo"
    && normalized !== "dry-run"
    && normalized !== "stubbed"
    && normalized !== "placeholder"
    && normalized !== "example"
    && !normalized.includes("example.invalid");
}

const GENERIC_STATUS_PATTERNS = [
  /^\s*outcome\s*:\s*(merge_approved|approved|completed|success|passed)\s*$/i,
  /^\s*(merge_approved|merge approved|approved|completed|done|success|passed)\s*$/i,
];

const DURABLE_SIGNAL_PATTERNS = [
  /\bimplement(?:ed|ation)?\b/i,
  /\bfix(?:ed)?\b/i,
  /\bchang(?:ed|e)\b/i,
  /\badd(?:ed)?\b/i,
  /\bremov(?:ed|e)\b/i,
  /\bdecid(?:ed|e|ion)\b/i,
  /\bchose\b/i,
  /\bavoid\b/i,
  /\bregression\b/i,
  /\brisk\b/i,
  /\bpattern\b/i,
  /\broot cause\b/i,
  /\bbecause\b/i,
  /\bcontract\b/i,
  /\bapi\b/i,
  /\bschema\b/i,
  /\bvalidation\b/i,
  /\btest(?:ed|s)?\b/i,
  /\bmigration\b/i,
  /\blesson\b/i,
  /\blearning\b/i,
  /\breusable\b/i,
  /\brequirement\b/i,
  /\bdependency\b/i,
];

function stripRunBoilerplate(text: string): string {
  return text
    .replace(/Run id:\s*ar-[a-z0-9-]+\.?/gi, "")
    .replace(/Durable result from completed agent run\.?/gi, "")
    .trim();
}

function isGenericStatusOnlyCandidate(candidate: MemoryCandidate): boolean {
  if (!GENERIC_STATUS_PATTERNS.some((pattern) => pattern.test(candidate.summary))) return false;
  const cleaned = stripRunBoilerplate(`${candidate.summary}\n${candidate.details}`);
  return !DURABLE_SIGNAL_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function shouldAutoPromoteAgentRun(input: {
  run: RunRow;
  session: SessionRow;
  events: AgentRunEvent[];
  candidate: MemoryCandidate;
  artifactRefs: Artifact[];
  evidenceConfidence: number;
}): PromotionGateResult {
  const metadata = readAgentRunRollupMetadata(input.run, input.session);
  const requestedAutoPromotion = metadata.policy === "auto_promote";
  const reasons = new Set<string>();

  if (metadata.policy === "none") reasons.add("policy_none");
  if (metadata.policy === "candidate_only") reasons.add("policy_candidate_only");
  if (input.run.status !== "completed") reasons.add("run_not_completed");

  if (metadata.runKind === "demo") reasons.add("demo_run");
  else if (metadata.runKind === "dry_run") reasons.add("dry_run");
  else if (requestedAutoPromotion && metadata.runKind !== "real") reasons.add("run_kind_not_real");

  if (metadata.sideEffectMode === "stubbed") reasons.add("stubbed_side_effects");
  else if (metadata.sideEffectMode === "mixed") reasons.add("mixed_side_effects");
  else if (requestedAutoPromotion && metadata.sideEffectMode !== "real") reasons.add("side_effect_mode_not_real");

  if (requestedAutoPromotion && input.evidenceConfidence < AUTO_PROMOTE_CONFIDENCE_MIN) {
    reasons.add("low_evidence_confidence");
  }
  if (requestedAutoPromotion && !hasRealContextUpdate(input.run)) reasons.add("missing_context_update");
  if (requestedAutoPromotion && !input.events.some((e) => e.event_type === "context_update_submitted")) {
    reasons.add("missing_context_update_submitted_event");
  }
  if (requestedAutoPromotion && !hasArtifactEvidence(input.events, input.artifactRefs)) {
    reasons.add("missing_artifact_evidence");
  }

  if (hasFinalWarningsOrErrors(input.run, metadata)) reasons.add("final_state_has_warnings_or_errors");
  if (isGenericStatusOnlyCandidate(input.candidate)) reasons.add("generic_status_summary");

  if (isCodeChangeWorkflow(input.events, input.artifactRefs)) {
    const prUrl = findPrUrl(metadata, input.artifactRefs, input.events);
    if (metadata.stubbedSystems.length > 0) reasons.add("stubbed_systems_present");
    if (metadata.realPrCreated === false) reasons.add("real_pr_not_confirmed");
    if (metadata.promotionIntent && metadata.promotionIntent !== "durable_learning") {
      reasons.add("promotion_intent_not_durable_learning");
    }
    if (prUrl && isPlaceholderUrl(prUrl)) reasons.add("placeholder_pr_url");

    if (requestedAutoPromotion) {
      if (!prUrl) reasons.add("missing_pr_url");
      if (metadata.realPrCreated !== true) reasons.add("real_pr_not_confirmed");
      if (metadata.promotionIntent !== "durable_learning") reasons.add("promotion_intent_not_durable_learning");
    }
  }

  return {
    allow: requestedAutoPromotion && reasons.size === 0,
    policy: metadata.policy,
    reasons: [...reasons],
  };
}

function summarizeRun(run: RunRow, events: AgentRunEvent[], metadata?: AgentRunRollupMetadata): { summary: string; details: string } {
  const learningSummary = metadata?.learningSummary?.trim();
  const learningDetails = metadata?.learningDetails?.trim();
  const final = run.final_output?.trim();
  const compacted = run.compacted_summary?.trim();
  const eventSummary = events.map((e) => e.summary).filter(Boolean).slice(-8).join("\n");
  const seed = learningSummary || learningDetails || final || compacted || eventSummary || run.input_prompt || `Agent run ${run.run_id}`;
  const firstLine = seed.split(/\n+/)[0].trim();
  const summary = firstLine.length >= 10 ? firstLine.slice(0, 500) : `Agent run outcome for ${run.agent_id}`;
  const details = [learningDetails, final, compacted, eventSummary, `Run id: ${run.run_id}`].filter(Boolean).join("\n\n");
  return {
    summary,
    details: details.length >= 30 ? details.slice(0, 4000) : `${summary}\n\nRun id: ${run.run_id}. Durable result from completed agent run.`,
  };
}

function scoreRunEvidenceConfidence(run: RunRow, events: AgentRunEvent[], text: { summary: string; details: string }): number {
  if (run.status !== "completed") return 0.6;
  let score = 0.6;
  if (run.final_output?.trim()) score += 0.1;
  if (run.context_update_id?.trim()) score += 0.15;
  if (text.details.length >= 500) score += 0.05;
  if (events.some((e) => e.event_type === "context_update_submitted")) score += 0.05;
  if (events.some((e) => e.event_type === "file_change" || e.artifact_refs.length > 0)) score += 0.05;
  return Math.min(0.95, score);
}

async function promoteCandidate(candidate: MemoryCandidate, auto: boolean): Promise<MemoryCandidate> {
  const project = candidate.project_id
    ? loadProject(candidate.org_id, candidate.project_id)
    : null;
  const pod = candidate.pod_id
    ? loadPod(candidate.org_id, candidate.pod_id)
    : null;
  const learning: EnhancedPodLearning = {
    type: candidate.type,
    summary: candidate.summary,
    details: candidate.details,
    retrieval_text: candidate.retrieval_text ?? undefined,
    entity_refs: candidate.entity_refs,
    domains: candidate.domains.length > 0 ? candidate.domains : ["agent-run"],
    confidence: candidate.confidence_score >= AUTO_PROMOTE_CONFIDENCE_MIN ? "extracted" : "inferred",
    confidence_score: candidate.confidence_score,
    audience: project ? "project" : "org",
    provenance: [
      {
        source: candidate.source_type,
        source_id: candidate.source_id,
        title: candidate.summary,
      },
    ],
    ingestion_provenance: {
      kind: "agent_run",
      run_id: `agent-memory:${candidate.id}`,
      model: stringFromRecord(asJsonRecord(candidate.evidence.extraction) ?? {}, "model") ?? "deterministic-rollup-v1",
      evidence_node_ids: [],
      evidence_item_ids: [],
    },
  };
  const result = await ingestLearnings(
    candidate.org_id,
    [learning],
    candidate.pod_id ?? `agent-session-${candidate.session_id ?? "unknown"}`,
    pod?.name ?? "Agent Run Memory",
    "agent_run",
    project ? { project_id: project.project_id, project_name: project.name } : undefined,
    { skipAnalysis: true },
  );
  const now = new Date().toISOString();
  const nodeId = result.nodeIds[0] ?? null;
  if (!nodeId) {
    const evidence = {
      ...candidate.evidence,
      promotion_error: {
        code: "kg_ingestion_returned_no_node_id",
        nodes_added: result.nodesAdded,
        dropped_count: result.droppedCount,
        recorded_at: now,
      },
    };
    db.prepare(
      "UPDATE memory_candidates SET evidence_json = ? WHERE org_id = ? AND id = ?",
    ).run(JSON.stringify(evidence), candidate.org_id, candidate.id);
    return getMemoryCandidate(candidate.org_id, candidate.id) ?? { ...candidate, evidence };
  }
  const status: MemoryCandidateStatus = auto ? "auto_promoted" : "promoted";
  db.prepare(
    "UPDATE memory_candidates SET status = ?, promoted_node_id = ?, reviewed_at = ? WHERE org_id = ? AND id = ?",
  ).run(status, nodeId, now, candidate.org_id, candidate.id);
  return getMemoryCandidate(candidate.org_id, candidate.id) ?? { ...candidate, status, promoted_node_id: nodeId, reviewed_at: now };
}

function getMemoryCandidate(orgId: string, candidateId: string): MemoryCandidate | null {
  const row = db
    .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND id = ?")
    .get(orgId, candidateId) as unknown as CandidateRow | undefined;
  return row ? toCandidate(row) : null;
}

export async function promoteMemoryCandidate(orgId: string, candidateId: string): Promise<MemoryCandidate | null> {
  const candidate = getMemoryCandidate(orgId, candidateId);
  if (!candidate) return null;
  if (candidate.status === "promoted" || candidate.status === "auto_promoted") return candidate;
  return promoteCandidate(candidate, false);
}

export function rejectMemoryCandidate(orgId: string, candidateId: string): MemoryCandidate | null {
  const candidate = getMemoryCandidate(orgId, candidateId);
  if (!candidate) return null;
  if (candidate.status === "promoted" || candidate.status === "auto_promoted") return candidate;
  const now = new Date().toISOString();
  db.prepare("UPDATE memory_candidates SET status = 'rejected', reviewed_at = ? WHERE org_id = ? AND id = ?").run(now, orgId, candidateId);
  return getMemoryCandidate(orgId, candidateId);
}

export async function rollupAgentRun(orgId: string, runId: string): Promise<MemoryCandidate | null> {
  const run = getRunRow(orgId, runId);
  if (!run) return null;
  const existing = db
    .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND source_type = 'agent_run' AND source_id = ?")
    .get(orgId, runId) as unknown as CandidateRow | undefined;
  if (existing) return toCandidate(existing);

  const session = getSessionRow(orgId, run.session_id);
  if (!session) return null;
  const rollupMetadata = readAgentRunRollupMetadata(run, session);
  if (rollupMetadata.policy === "none") return null;
  const events = (db
    .prepare("SELECT * FROM agent_run_events WHERE org_id = ? AND run_id = ? ORDER BY seq ASC")
    .all(orgId, runId) as unknown as EventRow[]).map(toEvent);
  const text = summarizeRun(run, events, rollupMetadata);
  const artifactRefs = events.flatMap((e) => e.artifact_refs);
  const project = loadProject(orgId, run.project_id);
  const pod = loadPod(orgId, run.pod_id);
  const entityRefs = extractEntityRefs({
    orgId,
    project,
    pod,
    scope: run.scope,
    agentId: run.agent_id,
    type: "agent_run",
    summary: text.summary,
    details: text.details,
    artifacts: artifactRefs,
    source: "agent_run",
  });
  persistMemoryEntities(orgId, entityRefs, { source_run_id: run.run_id });
  const candidateTypeValue = candidateType(text.summary, text.details);
  const retrievalText = buildRetrievalText({
    kind: "memory_candidate",
    summary: text.summary,
    details: text.details,
    type: candidateTypeValue,
    projectName: project?.name,
    podName: pod?.name,
    scope: run.scope,
    agentId: run.agent_id,
    source: "agent_run",
    artifacts: artifactRefs,
    entityRefs,
    currentStatus: "current",
    provenance: [`session_id:${run.session_id}`, `run_id:${run.run_id}`],
  });
  const evidenceConfidence = scoreRunEvidenceConfidence(run, events, text);
  const candidateId = id("mc");
  const now = new Date().toISOString();
  const domains = [...new Set([run.scope, run.project_id, "agent-run"].filter((v): v is string => !!v))];
  const draftCandidate: MemoryCandidate = {
    id: candidateId,
    org_id: orgId,
    project_id: run.project_id,
    pod_id: run.pod_id,
    session_id: run.session_id,
    run_id: run.run_id,
    source_type: "agent_run",
    source_id: run.run_id,
    type: candidateTypeValue,
    summary: text.summary,
    details: text.details,
    retrieval_text: retrievalText,
    entity_refs: entityRefs,
    domains,
    confidence_score: evidenceConfidence,
    evidence: {},
    status: "pending",
    promoted_node_id: null,
    created_at: now,
    reviewed_at: null,
  };
  const promotionGate = shouldAutoPromoteAgentRun({
    run,
    session,
    events,
    candidate: draftCandidate,
    artifactRefs,
    evidenceConfidence,
  });
  const confidence = promotionGate.allow ? evidenceConfidence : Math.min(evidenceConfidence, AGENT_RUN_CONFIDENCE_CAP);
  const evidence = {
    session_id: run.session_id,
    run_id: run.run_id,
    event_count: events.length,
    context_update_id: run.context_update_id,
    evidence_confidence: evidenceConfidence,
    promotion_gate: {
      decision: promotionGate.allow ? "allowed" : "blocked",
      policy: promotionGate.policy,
      reasons: promotionGate.reasons,
    },
  };
  const candidate = withImmediateTransaction(() => {
    const existing = db
      .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND source_type = 'agent_run' AND source_id = ?")
      .get(orgId, runId) as unknown as CandidateRow | undefined;
    if (existing) return toCandidate(existing);

    try {
      db.prepare(
        `INSERT INTO memory_candidates
           (id, org_id, project_id, pod_id, session_id, run_id, source_type, source_id, type, summary, details,
            retrieval_text, entity_refs_json, domains_json, confidence_score, evidence_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'agent_run', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(
        candidateId,
        orgId,
        run.project_id,
        run.pod_id,
        run.session_id,
        run.run_id,
        run.run_id,
        candidateTypeValue,
        text.summary,
        text.details,
        retrievalText,
        JSON.stringify(entityRefs),
        JSON.stringify(domains),
        confidence,
        JSON.stringify(evidence),
        now,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: memory_candidates.org_id, memory_candidates.source_type, memory_candidates.source_id")) {
        const row = db
          .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND source_type = 'agent_run' AND source_id = ?")
          .get(orgId, runId) as unknown as CandidateRow | undefined;
        if (row) return toCandidate(row);
      }
      throw err;
    }
    return getMemoryCandidate(orgId, candidateId);
  });
  if (candidate?.status === "pending" && promotionGate.allow) {
    try {
      return await promoteCandidate(candidate, true);
    } catch (err) {
      console.error(`[agent-memory] auto-promote failed for ${candidate.id}:`, err);
    }
  }
  return candidate;
}

function listAgentSessionRollupCandidates(orgId: string, sessionId: string): MemoryCandidate[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_candidates
       WHERE org_id = ? AND session_id = ? AND source_type = 'agent_session'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(orgId, sessionId) as unknown as CandidateRow[];
  return rows.map(toCandidate);
}

function promotionGateForSessionSeed(input: {
  seed: AgentSessionSeed;
  session: SessionRow;
  run?: RunRow;
  events: AgentRunEvent[];
  candidate: MemoryCandidate;
  artifactRefs: Artifact[];
  sessionPolicy: AgentMemoryRollupPolicy;
}): PromotionGateResult {
  if (input.run) {
    return shouldAutoPromoteAgentRun({
      run: input.run,
      session: input.session,
      events: input.events,
      candidate: input.candidate,
      artifactRefs: input.artifactRefs,
      evidenceConfidence: input.seed.confidenceScore,
    });
  }
  const reasons = new Set<string>();
  if (input.sessionPolicy === "none") reasons.add("policy_none");
  if (input.sessionPolicy === "candidate_only") reasons.add("policy_candidate_only");
  if (input.sessionPolicy === "auto_promote") reasons.add("no_primary_evidence_run");
  return {
    allow: false,
    policy: input.sessionPolicy,
    reasons: [...reasons],
  };
}

function createOrLoadAgentSessionCandidate(input: {
  orgId: string;
  session: SessionRow;
  seed: AgentSessionSeed;
  runsById: Map<string, RunRow>;
  eventsByRun: Map<string, AgentRunEvent[]>;
  sessionPolicy: AgentMemoryRollupPolicy;
}): MemoryCandidate | null {
  const sourceId = stableAgentSessionSourceId(
    input.session.session_id,
    input.seed.type,
    input.seed.summary,
    input.seed.details,
  );
  const existing = db
    .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND source_type = 'agent_session' AND source_id = ?")
    .get(input.orgId, sourceId) as unknown as CandidateRow | undefined;
  if (existing) {
    const candidate = toCandidate(existing);
    return candidate.status === "rejected" ? null : candidate;
  }

  const primaryRun = input.seed.primaryRunId ? input.runsById.get(input.seed.primaryRunId) : undefined;
  if (primaryRun && readAgentRunRollupMetadata(primaryRun, input.session).policy === "none") return null;

  const project = loadProject(input.orgId, input.session.project_id);
  const pod = loadPod(input.orgId, input.session.pod_id);
  const artifactRefs = uniqueArtifacts([
    ...input.seed.artifactRefs,
    ...(primaryRun ? artifactRefsForRun(input.eventsByRun.get(primaryRun.run_id) ?? []) : []),
  ]);
  const entityRefs = extractEntityRefs({
    orgId: input.orgId,
    project,
    pod,
    scope: input.session.scope ?? input.seed.domains[0],
    agentId: input.session.agent_id,
    type: input.seed.type,
    summary: input.seed.summary,
    details: input.seed.details,
    artifacts: artifactRefs,
    source: "agent_session",
  });
  persistMemoryEntities(input.orgId, entityRefs, {
    source_type: "agent_session",
    session_id: input.session.session_id,
    source_run_ids: input.seed.sourceRunIds,
  });
  const domains = uniqueStrings([
    ...input.seed.domains,
    input.session.scope,
    input.session.project_id,
    "agent-session",
  ]);
  const retrievalText = buildRetrievalText({
    kind: "memory_candidate",
    summary: input.seed.summary,
    details: input.seed.details,
    type: input.seed.type,
    projectName: project?.name,
    podName: pod?.name,
    scope: input.session.scope,
    agentId: input.session.agent_id,
    source: "agent_session",
    artifacts: artifactRefs,
    entityRefs,
    currentStatus: "current",
    provenance: [
      `session_id:${input.session.session_id}`,
      ...input.seed.sourceRunIds.map((runId) => `run_id:${runId}`),
      ...input.seed.evidenceRefs,
    ],
  });
  const candidateId = id("mc");
  const now = new Date().toISOString();
  const draftCandidate: MemoryCandidate = {
    id: candidateId,
    org_id: input.orgId,
    project_id: input.session.project_id,
    pod_id: input.session.pod_id,
    session_id: input.session.session_id,
    run_id: primaryRun?.run_id ?? null,
    source_type: "agent_session",
    source_id: sourceId,
    type: input.seed.type,
    summary: input.seed.summary,
    details: input.seed.details,
    retrieval_text: retrievalText,
    entity_refs: entityRefs,
    domains,
    confidence_score: input.seed.confidenceScore,
    evidence: {},
    status: "pending",
    promoted_node_id: null,
    created_at: now,
    reviewed_at: null,
  };
  const runEvents = primaryRun ? input.eventsByRun.get(primaryRun.run_id) ?? [] : [];
  const promotionGate = promotionGateForSessionSeed({
    seed: input.seed,
    session: input.session,
    run: primaryRun,
    events: runEvents,
    candidate: draftCandidate,
    artifactRefs,
    sessionPolicy: input.sessionPolicy,
  });
  const evidence = {
    session_id: input.session.session_id,
    run_id: primaryRun?.run_id ?? null,
    source_run_ids: input.seed.sourceRunIds,
    evidence_confidence: input.seed.confidenceScore,
    extraction: {
      kind: input.seed.extractionKind,
      model: input.seed.extractionModel,
      durability: input.seed.durability,
      confidence_label: input.seed.confidenceLabel,
      evidence_refs: input.seed.evidenceRefs,
    },
    promotion_gate: {
      decision: promotionGate.allow ? "allowed" : "blocked",
      policy: promotionGate.policy,
      reasons: promotionGate.reasons,
    },
  };

  return withImmediateTransaction(() => {
    const existingInTransaction = db
      .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND source_type = 'agent_session' AND source_id = ?")
      .get(input.orgId, sourceId) as unknown as CandidateRow | undefined;
    if (existingInTransaction) {
      const candidate = toCandidate(existingInTransaction);
      return candidate.status === "rejected" ? null : candidate;
    }
    try {
      db.prepare(
        `INSERT INTO memory_candidates
           (id, org_id, project_id, pod_id, session_id, run_id, source_type, source_id, type, summary, details,
            retrieval_text, entity_refs_json, domains_json, confidence_score, evidence_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'agent_session', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(
        candidateId,
        input.orgId,
        input.session.project_id,
        input.session.pod_id,
        input.session.session_id,
        primaryRun?.run_id ?? null,
        sourceId,
        input.seed.type,
        input.seed.summary,
        input.seed.details,
        retrievalText,
        JSON.stringify(entityRefs),
        JSON.stringify(domains),
        input.seed.confidenceScore,
        JSON.stringify(evidence),
        now,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: memory_candidates.org_id, memory_candidates.source_type, memory_candidates.source_id")) {
        const row = db
          .prepare("SELECT * FROM memory_candidates WHERE org_id = ? AND source_type = 'agent_session' AND source_id = ?")
          .get(input.orgId, sourceId) as unknown as CandidateRow | undefined;
        if (row) {
          const candidate = toCandidate(row);
          return candidate.status === "rejected" ? null : candidate;
        }
      }
      throw err;
    }
    return getMemoryCandidate(input.orgId, candidateId);
  });
}

function uniqueArtifacts(artifacts: Artifact[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.type}|${artifact.path ?? ""}|${artifact.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(artifact);
  }
  return out;
}

export async function rollupAgentSession(orgId: string, sessionId: string): Promise<MemoryCandidate[]> {
  const existing = listAgentSessionRollupCandidates(orgId, sessionId);
  const activeExisting = existing.filter((candidate) => candidate.status !== "rejected");
  const activeByContent = new Map<string, MemoryCandidate>();
  const rejectedContent = new Set<string>();
  for (const candidate of existing) {
    const key = normalizedCandidateContent(candidate.type, candidate.summary, candidate.details);
    if (candidate.status === "rejected") {
      rejectedContent.add(key);
      continue;
    }
    if (!activeByContent.has(key)) activeByContent.set(key, candidate);
  }

  const session = getSessionRow(orgId, sessionId);
  if (!session) return activeExisting;
  const sessionPolicy = readAgentSessionRollupPolicy(session);
  if (sessionPolicy === "none") return activeExisting;

  const runs = db
    .prepare("SELECT * FROM agent_runs WHERE org_id = ? AND session_id = ? ORDER BY started_at ASC")
    .all(orgId, sessionId) as unknown as RunRow[];
  const events = (db
    .prepare("SELECT * FROM agent_run_events WHERE org_id = ? AND session_id = ? ORDER BY created_at ASC, seq ASC")
    .all(orgId, sessionId) as unknown as EventRow[]).map(toEvent);
  const checkpoints = (db
    .prepare("SELECT * FROM agent_checkpoints WHERE org_id = ? AND session_id = ? ORDER BY seq ASC")
    .all(orgId, sessionId) as unknown as CheckpointRow[]).map(toCheckpoint);
  const contextUpdateRunMap = buildContextUpdateRunMap(runs, events);
  const contextUpdateIds = uniqueStrings([
    ...runs.map((run) => run.context_update_id),
    ...events
      .filter((event) => event.event_type === "context_update_submitted")
      .map((event) => extractContextUpdateIdFromPayload(event.payload)),
  ]);
  const { podUpdates, projectUpdates } = loadContextUpdateRows(orgId, contextUpdateIds);
  const refToRunIds = buildSessionEvidenceRefs({ runs, events, checkpoints, contextUpdateRunMap });

  const deterministic = await scoreDeterministicSeeds(extractDeterministicAgentSessionSeeds({
    session,
    runs,
    events,
    checkpoints,
    podUpdates,
    projectUpdates,
    contextUpdateRunMap,
  }));
  const contentKeys = new Set([
    ...activeByContent.keys(),
    ...rejectedContent,
    ...deterministic.map((seed) => normalizedCandidateContent(seed.type, seed.summary, seed.details)),
  ]);
  let llmSeeds: AgentSessionSeed[] = [];
  try {
    llmSeeds = await extractLLMAgentSessionSeeds({
      session,
      runs,
      events,
      checkpoints,
      podUpdates,
      projectUpdates,
      refToRunIds,
      existingContent: contentKeys,
    });
  } catch (err) {
    console.error(`[agent-memory] agent-session LLM extraction failed for ${sessionId}:`, err);
  }

  const runsById = new Map(runs.map((run) => [run.run_id, run]));
  const eventsByRun = new Map<string, AgentRunEvent[]>();
  for (const event of events) {
    const current = eventsByRun.get(event.run_id) ?? [];
    current.push(event);
    eventsByRun.set(event.run_id, current);
  }
  const rolled: MemoryCandidate[] = [...activeExisting];
  const rolledIds = new Set(rolled.map((candidate) => candidate.id));
  const seen = new Set<string>();
  for (const seed of [...deterministic, ...llmSeeds]) {
    const key = normalizedCandidateContent(seed.type, seed.summary, seed.details);
    if (seen.has(key)) continue;
    seen.add(key);
    if (rejectedContent.has(key) || activeByContent.has(key)) continue;
    const candidate = createOrLoadAgentSessionCandidate({
      orgId,
      session,
      seed,
      runsById,
      eventsByRun,
      sessionPolicy,
    });
    if (!candidate || candidate.status === "rejected" || rolledIds.has(candidate.id)) continue;
    if (candidate.status === "pending") {
      const gate = asJsonRecord(candidate.evidence.promotion_gate);
      if (gate?.decision === "allowed") {
        const promoted = await promoteCandidate(candidate, true);
        rolled.push(promoted);
        rolledIds.add(promoted.id);
        continue;
      }
    }
    rolled.push(candidate);
    rolledIds.add(candidate.id);
  }
  return rolled;
}

export function closeAgentSession(orgId: string, sessionId: string): AgentSession | null {
  const row = getSessionRow(orgId, sessionId);
  if (!row) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE agent_sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE org_id = ? AND session_id = ?").run(
    now,
    now,
    orgId,
    sessionId,
  );
  const updated = getSessionRow(orgId, sessionId);
  return updated ? toSession(updated) : null;
}

export function createAgentCheckpointInTransaction(orgId: string, sessionId: string, input: {
  run_id?: string | null;
  snapshot: JsonRecord;
  summary?: string | null;
  artifact_refs?: Artifact[];
}): AgentCheckpoint | null {
  return withTransaction(() => createAgentCheckpoint(orgId, sessionId, input));
}
