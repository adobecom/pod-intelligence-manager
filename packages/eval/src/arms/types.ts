import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";

/**
 * Shape we persist to disk. Kept structural (not @pim/sdk's SessionContext)
 * so loaders don't need the SDK at parse time.
 */
export interface SessionContextFixture {
  podId: string;
  pulledAt: string;
  /** The SessionContext payload as returned by PimClient.pullSessionContext(). */
  payload: {
    pod: { pod_id: string; name: string; milestone?: { name: string }; conflict_pressure?: number; areas?: unknown[] };
    livingDocMarkdown: string;
    conflicts: Array<{
      id: string;
      summary: string;
      severity: string;
      status: string;
      sides: Array<{ contributor: string; position: string }>;
      master_analysis: string;
      impact: string[];
    }>;
    relevantLearnings: {
      nodes: Array<{
        type: string;
        summary: string;
        details: string;
        domains: string[];
        confidence_score: number;
        source_pod_name?: string;
      }>;
      total_matching: number;
      truncated: boolean;
    };
    recentUpdates: Array<{
      agent_id: string;
      timestamp: string;
      type: string;
      summary: string;
      details: string;
      status: string;
    }>;
  };
}

export interface Arm {
  readonly id: string;
  readonly label: string;
  /** Whether this arm injects PIM context (treatment) or not (control). */
  readonly usesPim: boolean;
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments;
}
