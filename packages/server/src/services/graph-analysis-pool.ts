import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import type {
  AnalyzeResponse,
  BuildEdgesResponse,
  WorkerRequest,
  WorkerResponse,
} from "../workers/graph-analysis-worker.js";
import type {
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeNode,
} from "@pim/shared";

// The bootstrap .mjs registers tsx's ESM loader inline, then dynamically imports
// the .ts worker entry. This avoids relying on the parent's --import flags
// (which don't carry into worker_threads reliably across vitest / tsx / prod).
const WORKER_URL = new URL("../workers/graph-analysis-worker.bootstrap.mjs", import.meta.url);

interface PendingRequest {
  resolve: (value: WorkerResponse) => void;
  reject: (reason: Error) => void;
}

class GraphAnalysisPool {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  /**
   * When the worker dies (uncaught throw, OOM, etc.) the pool respawns lazily on
   * the next dispatch. Pending requests against the dead worker are rejected.
   */
  private workerStartFailures = 0;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(WORKER_URL);

    worker.on("message", (msg: WorkerResponse) => {
      const handler = this.pending.get(msg.requestId);
      if (!handler) return;
      this.pending.delete(msg.requestId);
      if (msg.type === "error") {
        handler.reject(new Error(msg.error));
      } else {
        handler.resolve(msg);
      }
    });

    worker.on("error", (err) => {
      console.error("[graph-analysis-pool] Worker emitted error:", err);
      this.failPendingAndReset(err);
    });

    worker.on("exit", (code) => {
      if (code === 0) return;
      console.error(`[graph-analysis-pool] Worker exited with code ${code}`);
      this.failPendingAndReset(new Error(`Worker exited with code ${code}`));
    });

    this.worker = worker;
    return worker;
  }

  private failPendingAndReset(err: Error): void {
    for (const handler of this.pending.values()) {
      handler.reject(err);
    }
    this.pending.clear();
    this.worker = null;
    this.workerStartFailures++;
  }

  private dispatch<T extends WorkerResponse>(payload: WorkerRequest): Promise<T> {
    const worker = this.ensureWorker();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(payload.requestId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      worker.postMessage(payload);
    });
  }

  async analyze(graph: KnowledgeGraph, fromVersion: number): Promise<AnalyzeResponse> {
    return this.dispatch<AnalyzeResponse>({
      type: "analyze",
      requestId: randomUUID(),
      fromVersion,
      graph,
    });
  }

  async buildEdges(
    newNodes: KnowledgeNode[],
    existingNodes: KnowledgeNode[],
    existingEdges?: KnowledgeEdge[],
  ): Promise<BuildEdgesResponse> {
    return this.dispatch<BuildEdgesResponse>({
      type: "build_edges",
      requestId: randomUUID(),
      newNodes,
      existingNodes,
      existingEdges,
    });
  }

  /** Test helper. Terminate the worker so the next dispatch spawns a fresh one. */
  async _terminateForTests(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
    for (const handler of this.pending.values()) {
      handler.reject(new Error("Pool terminated for tests"));
    }
    this.pending.clear();
  }

  /** Test helper. */
  _spawnFailures(): number {
    return this.workerStartFailures;
  }
}

let _instance: GraphAnalysisPool | null = null;

export function getGraphAnalysisPool(): GraphAnalysisPool {
  if (!_instance) _instance = new GraphAnalysisPool();
  return _instance;
}

/** Test helper: drop the singleton so the next call spawns a fresh pool. */
export async function _resetGraphAnalysisPoolForTests(): Promise<void> {
  if (_instance) await _instance._terminateForTests();
  _instance = null;
}

export function isGraphWorkerEnabled(): boolean {
  return process.env.PIM_GRAPH_WORKER === "true";
}

export type { AnalyzeResponse, BuildEdgesResponse } from "../workers/graph-analysis-worker.js";
