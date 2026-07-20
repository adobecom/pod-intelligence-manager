import type { FixtureLearnings } from "../arms/types.js";
import type { Task } from "../tasks/types.js";

export const TASK_KG_QUERY_MAX_CHARS = 1_200;
export const KG_CANDIDATE_LIMIT = 10;

export interface ExplicitKnowledgeQueryRequest {
  filters: {
    scopes: string[];
    include_project_id?: string;
  };
  max_tokens: number;
  include_details: boolean;
  limit: number;
  expand_graph: boolean;
  include_explanations: boolean;
  record_retrievals: false;
  query_text?: string;
  query_mode?: "as_of";
  as_of?: string;
}

function compactTaskText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= TASK_KG_QUERY_MAX_CHARS) return compact;
  const separator = " … ";
  const tailLength = Math.floor(TASK_KG_QUERY_MAX_CHARS * 0.35);
  const headLength = TASK_KG_QUERY_MAX_CHARS - separator.length - tailLength;
  return `${compact.slice(0, headLength).trimEnd()}${separator}${compact.slice(-tailLength).trimStart()}`;
}

/**
 * Build the production-like retrieval query from caller-visible task text only.
 * Eval-only identifiers, tags, expected signals, source dumps, and output-format
 * instructions must not sharpen the PIM arm's retrieval.
 */
export function buildTaskKgQuery(task: Task): string {
  const callerVisiblePrompt = task.prompt
    .split(/(?:^|\n)#\s+(?:Current source|Output)\b/i, 1)[0]
    // Keep caller-visible code identifiers, but drop Markdown fence markers.
    .replace(/```[^\n]*/g, " ");
  return compactTaskText(callerVisiblePrompt);
}

/** Build the explicit semantic-query request used by the eval freezer. */
export function buildExplicitKnowledgeQueryRequest(
  domains: string[],
  projectId: string | undefined,
  queryText: string | undefined,
  asOf?: string,
): ExplicitKnowledgeQueryRequest {
  const taskQuery = queryText?.trim();
  const temporalCutoff = asOf?.trim();
  return {
    filters: {
      scopes: domains,
      ...(projectId ? { include_project_id: projectId } : {}),
    },
    max_tokens: 4_000,
    include_details: true,
    limit: KG_CANDIDATE_LIMIT,
    expand_graph: false,
    include_explanations: true,
    record_retrievals: false,
    ...(taskQuery ? { query_text: taskQuery } : {}),
    ...(temporalCutoff ? { query_mode: "as_of" as const, as_of: temporalCutoff } : {}),
  };
}

export function assertKgContractSourceCompatibility(
  source: "query" | "relevant",
  requestedMode: "legacy" | "shadow" | "task_relevant" | undefined,
): void {
  if (source !== "query" || requestedMode === undefined) return;
  throw new Error(
    "EVAL_PIM_KG_CONTRACT_MODE only applies when EVAL_PIM_KG_SOURCE=relevant; refusing a silent no-op",
  );
}

/** The relevant convenience route has no temporal-query contract. */
export function assertRetrievalSourceSupportsAsOf(
  source: "query" | "relevant",
  asOf: string | undefined,
  podId: string,
): void {
  if (source !== "relevant" || !asOf?.trim()) return;
  throw new Error(
    `GET /api/knowledge/relevant cannot honor as-of retrieval for pod ${podId}; use EVAL_PIM_KG_SOURCE=query`,
  );
}

/**
 * A requested task-relevant contract is part of the fixture's provenance. Do
 * not silently freeze legacy/shadow output under a task-relevant experiment.
 */
export function assertRequestedTaskRelevantContract(
  learnings: Pick<FixtureLearnings, "context_contract">,
  options: {
    requestedMode: "legacy" | "shadow" | "task_relevant" | undefined;
    taskQuery: string | undefined;
    podId: string;
  },
): void {
  if (options.requestedMode !== "task_relevant" || !options.taskQuery?.trim()) return;

  const contract = learnings.context_contract;
  const valid =
    contract?.mode === "task_relevant" &&
    contract.returned_mode === "task_relevant" &&
    contract.task_query_used === true &&
    contract.possible_constraints !== true;
  if (valid) return;

  const actual = contract
    ? `${contract.mode}/${contract.returned_mode}; task_query_used=${contract.task_query_used}`
    : "missing context_contract";
  throw new Error(
    `GET /api/knowledge/relevant for pod ${options.podId} did not honor requested task_relevant contract (${actual})`,
  );
}

export type LiveTaskLearningFetcher = (
  podId: string,
  queryText: string,
  asOf?: string,
) => Promise<FixtureLearnings>;

/** Fetch one task fixture without ever degrading to broad pod-level context. */
export async function fetchRequiredTaskLearnings(
  podId: string,
  task: Task,
  fetcher: LiveTaskLearningFetcher,
): Promise<FixtureLearnings> {
  const taskQuery = buildTaskKgQuery(task);
  if (!taskQuery) {
    throw new Error(`Task KG retrieval query is empty for ${task.id}; refusing pod-level fallback`);
  }
  try {
    return await fetcher(podId, taskQuery, task.asOf);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Task KG retrieval failed for ${task.id} (${message}); refusing pod-level fallback`,
      { cause: err },
    );
  }
}
