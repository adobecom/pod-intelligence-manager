export type {
  Pod,
  Milestone,
  PodArea,
  AreaStatus,
  Scope,
} from "./types/pod.js";

export type {
  Project,
  ProjectContextUpdate,
  ProjectResources,
  ProjectGlossaryTerm,
  ProjectAnatomy,
  ProjectAnatomyInternalSlot,
  ProjectAnatomyExternalTeam,
  ProjectEvidenceSource,
  ProjectEvidenceItem,
  ProjectMemoryCandidateStatus,
  ProjectMemoryCandidate,
  ProjectIngestionCursor,
  ProjectAnswerIntent,
  ProjectAnswerRequest,
  ProjectAnswerCitation,
  ProjectAnswerRawHit,
  ProjectAnswerUnavailableSource,
  ProjectAnswerResponse,
  ProjectSourceHealth,
} from "./types/project.js";

export { EMPTY_PROJECT_ANATOMY } from "./types/project.js";

export type {
  OrgConfig,
  OrgScopeDefinition,
  OrgTuning,
} from "./types/org-settings.js";

export { DEFAULT_ORG_CONFIG, DEFAULT_ORG_TUNING } from "./types/org-settings.js";

export type {
  ContextUpdate,
  ContextUpdateType,
  ContextUpdateSource,
  WorkStatus,
  Artifact,
  InputRequest,
} from "./types/context-update.js";

export type {
  Conflict,
  ConflictSide,
  ConflictStatus,
  ConflictSeverity,
  PendingWork,
} from "./types/conflict.js";

export type { Tunnel, TunnelStatus } from "./types/tunnel.js";

export type {
  TunnelRequest,
  TunnelResponse,
  TunnelResponseChunk,
  TunnelHeartbeat,
  TunnelHeartbeatAck,
  TunnelError,
  TunnelMessage,
} from "./types/tunnel-protocol.js";

export {
  TUNNEL_CHUNK_THRESHOLD,
  TUNNEL_REQUEST_TIMEOUT_MS,
  TUNNEL_WS_HEARTBEAT_MS,
} from "./types/tunnel-protocol.js";

export type {
  KnowledgeNodeType,
  ConfidenceLevel,
  KnowledgeIngestionProvenanceKind,
  KnowledgeIngestionProvenance,
  KnowledgeAudience,
  KnowledgeProvenance,
  KnowledgeNode,
  KnowledgeEdgeType,
  KnowledgeEdge,
  CommunitySummary,
  KnowledgeGraph,
  KnowledgeQueryFilters,
  KnowledgeQueryOptions,
  KnowledgeQueryResult,
  KnowledgeStats,
  EnhancedPodLearning,
  CurationAction,
  CurationRequest,
  AdHocLearningInput,
} from "./types/graph.js";

export type {
  MemoryEntityType,
  MemoryEntityRef,
  TemporalQueryMode,
  RetrievalTier,
  TemporalRelationship,
  AgentSessionStatus,
  AgentRunStatus,
  AgentRunEventType,
  AgentSession,
  AgentRun,
  AgentRunEvent,
  AgentCheckpoint,
  MemoryCandidateStatus,
  MemoryCandidate,
  AgentResumeContext,
} from "./types/memory.js";

export { AGENT_RUN_EVENT_TYPES } from "./types/memory.js";

export type {
  OrgPodSummary,
  CrossPodOverlap,
  ArchivedPod,
  PodArchiveJob,
  PodArchiveJobStatus,
  ArchivedProject,
} from "./types/org.js";

export type {
  ContextSource,
  ContextSearchRequest,
  ContextSearchHit,
  ContextSearchMissingSource,
  ContextSearchResult,
  ContextSearchActor,
} from "./types/context-search.js";

export { CONTEXT_SOURCES } from "./types/context-search.js";

export type {
  LivingDocViewerStat,
  LivingDocStats,
} from "./types/living-doc.js";

export {
  PRESSURE_THRESHOLDS,
  getPressureLevel,
  getPressureLabel,
} from "./constants/pressure.js";

export type { PressureLevel } from "./constants/pressure.js";

export {
  pods,
  conflicts,
  pendingWorkByConflictId,
  contextUpdates,
  tunnels,
  orgPods,
  crossPodOverlaps,
  archivedPods,
  livingDocs,
} from "./fixtures/index.js";
