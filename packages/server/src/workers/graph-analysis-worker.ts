import { parentPort } from "node:worker_threads";
import type {
  CommunitySummary,
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeNode,
} from "@pim/shared";
import {
  buildEdges,
  detectCommunities,
  identifyHubs,
} from "../services/graph-analysis.js";

export interface AnalyzeRequest {
  type: "analyze";
  requestId: string;
  fromVersion: number;
  graph: KnowledgeGraph;
}

export interface BuildEdgesRequest {
  type: "build_edges";
  requestId: string;
  newNodes: KnowledgeNode[];
  existingNodes: KnowledgeNode[];
  existingEdges?: KnowledgeEdge[];
}

export type WorkerRequest = AnalyzeRequest | BuildEdgesRequest;

export interface AnalyzeResponse {
  requestId: string;
  type: "analyze";
  fromVersion: number;
  communities: CommunitySummary[];
  hubIds: string[];
  /** node.id -> community_id assignments captured before serialization */
  nodeCommunityMap: Record<string, string>;
}

export interface BuildEdgesResponse {
  requestId: string;
  type: "build_edges";
  edges: KnowledgeEdge[];
}

export interface ErrorResponse {
  requestId: string;
  type: "error";
  error: string;
}

export type WorkerResponse = AnalyzeResponse | BuildEdgesResponse | ErrorResponse;

function handleAnalyze(req: AnalyzeRequest): AnalyzeResponse {
  const communities = detectCommunities(req.graph);
  const hubIds = identifyHubs(req.graph);
  const nodeCommunityMap: Record<string, string> = {};
  for (const node of req.graph.nodes) {
    if (node.community_id) nodeCommunityMap[node.id] = node.community_id;
  }
  return {
    requestId: req.requestId,
    type: "analyze",
    fromVersion: req.fromVersion,
    communities,
    hubIds,
    nodeCommunityMap,
  };
}

function handleBuildEdges(req: BuildEdgesRequest): BuildEdgesResponse {
  const edges = buildEdges(req.newNodes, req.existingNodes, req.existingEdges);
  return { requestId: req.requestId, type: "build_edges", edges };
}

// Defensive: this module may be imported in tests without being run as a worker
// (e.g., to type-check the request/response shapes). Skip listener install when
// parentPort is null — Node sets it only when this file is the worker entry.
if (parentPort) {
  parentPort.on("message", (msg: WorkerRequest) => {
    try {
      if (msg.type === "analyze") {
        parentPort!.postMessage(handleAnalyze(msg));
      } else if (msg.type === "build_edges") {
        parentPort!.postMessage(handleBuildEdges(msg));
      } else {
        const exhaustiveCheck: never = msg;
        throw new Error(`Unknown worker request type: ${JSON.stringify(exhaustiveCheck)}`);
      }
    } catch (err) {
      const response: ErrorResponse = {
        requestId: (msg as { requestId: string }).requestId,
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      };
      parentPort!.postMessage(response);
    }
  });
}
