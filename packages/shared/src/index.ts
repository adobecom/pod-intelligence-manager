export type {
  Pod,
  Milestone,
  PodArea,
  AreaStatus,
  Scope,
} from "./types/pod";

export type {
  Project,
  ProjectContextUpdate,
  ProjectResources,
  ProjectAnatomy,
  ProjectAnatomyInternalSlot,
  ProjectAnatomyExternalTeam,
} from "./types/project";

export { EMPTY_PROJECT_ANATOMY } from "./types/project";

export type {
  OrgConfig,
  OrgScopeDefinition,
  OrgTuning,
} from "./types/org-settings";

export { DEFAULT_ORG_CONFIG, DEFAULT_ORG_TUNING } from "./types/org-settings";

export type {
  ContextUpdate,
  ContextUpdateType,
  ContextUpdateSource,
  WorkStatus,
  Artifact,
  InputRequest,
} from "./types/context-update";

export type {
  Conflict,
  ConflictSide,
  ConflictStatus,
  ConflictSeverity,
  PendingWork,
} from "./types/conflict";

export type { Tunnel, TunnelStatus } from "./types/tunnel";

export type {
  TunnelRequest,
  TunnelResponse,
  TunnelResponseChunk,
  TunnelHeartbeat,
  TunnelHeartbeatAck,
  TunnelError,
  TunnelMessage,
} from "./types/tunnel-protocol";

export {
  TUNNEL_CHUNK_THRESHOLD,
  TUNNEL_REQUEST_TIMEOUT_MS,
  TUNNEL_WS_HEARTBEAT_MS,
} from "./types/tunnel-protocol";

export type {
  KnowledgeNodeType,
  ConfidenceLevel,
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
} from "./types/graph";

export type {
  OrgPodSummary,
  CrossPodOverlap,
  ArchivedPod,
  ArchivedProject,
} from "./types/org";

export type {
  ContextSource,
  ContextSearchRequest,
  ContextSearchHit,
  ContextSearchMissingSource,
  ContextSearchResult,
  ContextSearchActor,
} from "./types/context-search";

export { CONTEXT_SOURCES } from "./types/context-search";

export type {
  LivingDocViewerStat,
  LivingDocStats,
} from "./types/living-doc";

export {
  PRESSURE_THRESHOLDS,
  getPressureLevel,
  getPressureLabel,
} from "./constants/pressure";

export type { PressureLevel } from "./constants/pressure";

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
} from "./fixtures/index";
