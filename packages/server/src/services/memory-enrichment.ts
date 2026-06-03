import crypto from "node:crypto";
import db from "../db/connection.js";
import type {
  Artifact,
  ContextUpdate,
  MemoryEntityRef,
  MemoryEntityType,
  ProjectContextUpdate,
  KnowledgeNode,
} from "@pim/shared";

type JsonRecord = Record<string, unknown>;

const HTTP_PATH_RE = /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./:{}-]+/g;
const JIRA_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const GH_PR_RE = /\b(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\b/g;
const API_NAME_RE = /\b[A-Z][A-Za-z0-9]*(?:API|Api|Service|Controller|Contract|Endpoint)\b/g;
const IDENTIFIER_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b|\b[A-Za-z_$][A-Za-z0-9_$]*(?:_[A-Za-z0-9_$]+)+\b|\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g;

function stableId(prefix: string, parts: unknown[]): string {
  const hash = crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

function entityId(type: MemoryEntityType, key: string): string {
  return stableId("me", [type, key.toLowerCase()]);
}

function cleanLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").slice(0, 200);
}

function addRef(refs: MemoryEntityRef[], type: MemoryEntityType, key: string, label?: string, source?: string): void {
  const cleanedKey = key.trim();
  if (!cleanedKey) return;
  const id = entityId(type, cleanedKey);
  if (refs.some((r) => r.id === id)) return;
  refs.push({
    type,
    id,
    label: cleanLabel(label ?? cleanedKey),
    source,
  });
}

function uniqueMatches(text: string, re: RegExp): string[] {
  return [...new Set(text.match(re) ?? [])].slice(0, 30);
}

function artifactsToText(artifacts: Artifact[]): string[] {
  return artifacts
    .flatMap((a) => [a.path, a.url])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

export function extractEntityRefs(input: {
  orgId?: string;
  project?: { project_id: string; name?: string | null } | null;
  pod?: { pod_id: string; name?: string | null } | null;
  scope?: string | null;
  agentId?: string | null;
  type?: string | null;
  summary?: string | null;
  details?: string | null;
  artifacts?: Artifact[];
  source?: string;
}): MemoryEntityRef[] {
  const refs: MemoryEntityRef[] = [];
  if (input.project?.project_id) addRef(refs, "project", input.project.project_id, input.project.name ?? input.project.project_id, "project");
  if (input.pod?.pod_id) addRef(refs, "pod", input.pod.pod_id, input.pod.name ?? input.pod.pod_id, "pod");
  if (input.scope) {
    addRef(refs, "scope", input.scope, input.scope, "scope");
    addRef(refs, "workstream", input.scope, input.scope, "scope");
  }
  if (input.agentId) addRef(refs, "agent", input.agentId, input.agentId, "agent");

  const artifacts = input.artifacts ?? [];
  const text = [
    input.type,
    input.summary,
    input.details,
    ...artifactsToText(artifacts),
  ].filter(Boolean).join("\n");

  for (const issue of uniqueMatches(text, JIRA_RE)) addRef(refs, "jira_issue", issue, issue, "text");
  for (const pr of uniqueMatches(text, GH_PR_RE)) addRef(refs, "github_pr", pr, pr, "text");
  for (const api of uniqueMatches(text, HTTP_PATH_RE)) addRef(refs, "api_contract", api, api, "text");
  for (const api of uniqueMatches(text, API_NAME_RE)) addRef(refs, "api_contract", api, api, "text");

  for (const identifier of uniqueMatches(text, IDENTIFIER_RE)) {
    if (identifier.length < 4) continue;
    addRef(refs, "component", identifier, identifier, "identifier");
  }

  for (const artifact of artifacts) {
    const value = artifact.path ?? artifact.url;
    if (!value) continue;
    addRef(refs, "artifact", value, value, artifact.type || "artifact");
    if (artifact.path) {
      const component = artifact.path.split(/[\\/]/).filter(Boolean).slice(0, 4).join("/");
      if (component) addRef(refs, "component", component, component, "artifact_path");
    }
  }

  if (input.type === "decision") {
    addRef(refs, "decision", input.summary ?? stableId("decision", [input.summary, input.details]), input.summary ?? "Decision", "update");
  }

  return refs;
}

function refsLine(refs: MemoryEntityRef[]): string {
  if (refs.length === 0) return "";
  return `Entities: ${refs.map((r) => `${r.type}:${r.label ?? r.id}`).join("; ")}`;
}

function artifactsLine(artifacts: Artifact[]): string {
  const refs = artifactsToText(artifacts);
  return refs.length > 0 ? `Artifacts: ${refs.join("; ")}` : "";
}

export function buildRetrievalText(input: {
  kind: "pod_context_update" | "project_context_update" | "knowledge_node" | "memory_candidate";
  summary: string;
  details: string;
  type?: string;
  status?: string | null;
  projectName?: string | null;
  podName?: string | null;
  scope?: string | null;
  agentId?: string | null;
  source?: string | null;
  artifacts?: Artifact[];
  entityRefs?: MemoryEntityRef[];
  currentStatus?: "current" | "superseded" | "historical";
  provenance?: string[];
}): string {
  const lines = [
    `Memory kind: ${input.kind}`,
    input.projectName ? `Project: ${input.projectName}` : "",
    input.podName ? `Pod: ${input.podName}` : "",
    input.scope ? `Scope/workstream: ${input.scope}` : "",
    input.agentId ? `Agent: ${input.agentId}` : "",
    input.type ? `Type: ${input.type}` : "",
    input.status ? `Work status: ${input.status}` : "",
    input.currentStatus ? `Temporal status: ${input.currentStatus}` : "",
    input.source ? `Source: ${input.source}` : "",
    `Summary: ${input.summary}`,
    input.details ? `Details: ${input.details}` : "",
    artifactsLine(input.artifacts ?? []),
    refsLine(input.entityRefs ?? []),
    input.provenance?.length ? `Provenance: ${input.provenance.join("; ")}` : "",
  ].filter((line) => line.trim().length > 0);
  return lines.join("\n");
}

function loadPodContext(podId: string | null | undefined, orgId: string | null | undefined) {
  if (!podId) return null;
  const row = orgId
    ? db.prepare("SELECT pod_id, name, project_id FROM pods WHERE pod_id = ? AND org_id = ?").get(podId, orgId)
    : db.prepare("SELECT pod_id, name, project_id FROM pods WHERE pod_id = ?").get(podId);
  return (row as { pod_id: string; name: string; project_id: string | null } | undefined) ?? null;
}

function loadProjectContext(projectId: string | null | undefined, orgId: string | null | undefined) {
  if (!projectId) return null;
  const row = orgId
    ? db.prepare("SELECT project_id, name FROM projects WHERE project_id = ? AND org_id = ?").get(projectId, orgId)
    : db.prepare("SELECT project_id, name FROM projects WHERE project_id = ?").get(projectId);
  return (row as { project_id: string; name: string } | undefined) ?? null;
}

export function buildPodContextUpdateMemory(orgId: string, update: ContextUpdate): {
  retrieval_text: string;
  entity_refs: MemoryEntityRef[];
} {
  const pod = loadPodContext(update.pod_id, orgId);
  const project = loadProjectContext(pod?.project_id, orgId);
  const entityRefs = extractEntityRefs({
    orgId,
    project,
    pod,
    scope: update.scope,
    agentId: update.agent_id,
    type: update.type,
    summary: update.summary,
    details: update.details,
    artifacts: update.artifacts,
    source: update.source,
  });
  return {
    entity_refs: entityRefs,
    retrieval_text: buildRetrievalText({
      kind: "pod_context_update",
      summary: update.summary,
      details: update.details,
      type: update.type,
      status: update.status,
      projectName: project?.name,
      podName: pod?.name,
      scope: update.scope,
      agentId: update.agent_id,
      source: update.source,
      artifacts: update.artifacts,
      entityRefs,
      currentStatus: "current",
    }),
  };
}

export function buildProjectContextUpdateMemory(orgId: string, update: ProjectContextUpdate): {
  retrieval_text: string;
  entity_refs: MemoryEntityRef[];
} {
  const project = loadProjectContext(update.project_id, orgId);
  const entityRefs = extractEntityRefs({
    orgId,
    project,
    scope: update.scope,
    agentId: update.agent_id,
    type: update.type,
    summary: update.summary,
    details: update.details,
    artifacts: update.artifacts,
    source: update.source,
  });
  return {
    entity_refs: entityRefs,
    retrieval_text: buildRetrievalText({
      kind: "project_context_update",
      summary: update.summary,
      details: update.details,
      type: update.type,
      status: update.status,
      projectName: project?.name,
      scope: update.scope,
      agentId: update.agent_id,
      source: update.source,
      artifacts: update.artifacts,
      entityRefs,
      currentStatus: "current",
    }),
  };
}

export function buildKnowledgeNodeMemory(input: {
  node: Pick<KnowledgeNode, "type" | "summary" | "details" | "domains" | "source_pod_id" | "source_pod_name" | "source_project_id" | "source_project_name" | "superseded_by">;
  orgId: string;
}): { retrieval_text: string; entity_refs: MemoryEntityRef[] } {
  const entityRefs = extractEntityRefs({
    orgId: input.orgId,
    project: input.node.source_project_id
      ? { project_id: input.node.source_project_id, name: input.node.source_project_name }
      : null,
    pod: { pod_id: input.node.source_pod_id, name: input.node.source_pod_name },
    scope: input.node.domains[0],
    type: input.node.type,
    summary: input.node.summary,
    details: input.node.details,
    source: "knowledge_graph",
  });
  return {
    entity_refs: entityRefs,
    retrieval_text: buildRetrievalText({
      kind: "knowledge_node",
      summary: input.node.summary,
      details: input.node.details,
      type: input.node.type,
      projectName: input.node.source_project_name,
      podName: input.node.source_pod_name,
      scope: input.node.domains.join(", "),
      source: "knowledge_graph",
      entityRefs,
      currentStatus: input.node.superseded_by ? "superseded" : "current",
      provenance: [`source_pod_id:${input.node.source_pod_id}`],
    }),
  };
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function entityRowId(orgId: string, ref: MemoryEntityRef): string {
  return stableId("me-row", [orgId, ref.id]);
}

export function persistMemoryEntities(orgId: string, refs: MemoryEntityRef[], metadata: JsonRecord = {}): void {
  if (refs.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO memory_entities (id, org_id, entity_type, entity_key, label, aliases_json, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)
     ON CONFLICT(org_id, entity_type, entity_key) DO UPDATE SET
       label = excluded.label,
       metadata_json = excluded.metadata_json,
       updated_at = excluded.updated_at`,
  );
  for (const ref of refs) {
    stmt.run(entityRowId(orgId, ref), orgId, ref.type, ref.id, ref.label ?? ref.id, JSON.stringify(metadata), now, now);
  }
}

function relationshipExists(orgId: string, sourceId: string, targetId: string, type: string, sourceUpdateId: string): boolean {
  const rows = db
    .prepare(
      `SELECT source_update_refs_json FROM memory_relationships
       WHERE org_id = ? AND source_entity_id = ? AND target_entity_id = ? AND relation_type = ?`,
    )
    .all(orgId, sourceId, targetId, type) as { source_update_refs_json: string }[];
  return rows.some((r) => parseJson<string[]>(r.source_update_refs_json, []).includes(sourceUpdateId));
}

function insertRelationship(input: {
  orgId: string;
  source: MemoryEntityRef;
  target: MemoryEntityRef;
  type: string;
  at: string;
  updateId: string;
  artifacts: Artifact[];
  reason: string;
  confidence?: number;
}): void {
  const sourceRowId = entityRowId(input.orgId, input.source);
  const targetRowId = entityRowId(input.orgId, input.target);
  if (sourceRowId === targetRowId) return;
  if (relationshipExists(input.orgId, sourceRowId, targetRowId, input.type, input.updateId)) return;
  const id = stableId("mr", [input.orgId, sourceRowId, targetRowId, input.type, input.updateId]);
  db.prepare(
    `INSERT INTO memory_relationships
       (id, org_id, source_entity_id, target_entity_id, relation_type, valid_from, committed_at,
        source_update_refs_json, artifact_refs_json, reason, confidence_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.orgId,
    sourceRowId,
    targetRowId,
    input.type,
    input.at,
    input.at,
    JSON.stringify([input.updateId]),
    JSON.stringify(input.artifacts),
    input.reason,
    input.confidence ?? 0.75,
    input.at,
  );
}

export function recordTemporalRelationshipsForUpdate(input: {
  orgId: string;
  updateId: string;
  timestamp: string;
  type: string;
  entityRefs: MemoryEntityRef[];
  artifacts: Artifact[];
  reason: string;
}): void {
  const refs = input.entityRefs;
  persistMemoryEntities(input.orgId, refs, { source_update_id: input.updateId });
  const pod = refs.find((r) => r.type === "pod");
  const project = refs.find((r) => r.type === "project");
  const scope = refs.find((r) => r.type === "scope") ?? refs.find((r) => r.type === "workstream");
  const agent = refs.find((r) => r.type === "agent");
  const decision = refs.find((r) => r.type === "decision");
  const anchors = [scope, pod, project].filter((r): r is MemoryEntityRef => !!r);
  const touched = refs.filter((r) =>
    ["component", "artifact", "api_contract", "jira_issue", "github_pr", "conflict"].includes(r.type),
  );

  if (agent && pod) {
    insertRelationship({
      orgId: input.orgId,
      source: agent,
      target: pod,
      type: "contributed_to",
      at: input.timestamp,
      updateId: input.updateId,
      artifacts: input.artifacts,
      reason: input.reason,
    });
  }
  if (agent && scope) {
    insertRelationship({
      orgId: input.orgId,
      source: agent,
      target: scope,
      type: "worked_on",
      at: input.timestamp,
      updateId: input.updateId,
      artifacts: input.artifacts,
      reason: input.reason,
    });
  }
  for (const anchor of anchors) {
    for (const target of touched) {
      insertRelationship({
        orgId: input.orgId,
        source: anchor,
        target,
        type: input.type === "decision" ? "decides_for" : "touches",
        at: input.timestamp,
        updateId: input.updateId,
        artifacts: input.artifacts,
        reason: input.reason,
      });
    }
  }
  if (decision) {
    for (const target of touched) {
      insertRelationship({
        orgId: input.orgId,
        source: decision,
        target,
        type: "decides_for",
        at: input.timestamp,
        updateId: input.updateId,
        artifacts: input.artifacts,
        reason: input.reason,
        confidence: 0.85,
      });
    }
  }
}
