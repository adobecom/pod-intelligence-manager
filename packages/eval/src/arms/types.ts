import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import type { LicFixtureQuality } from "../rigor/lic-quality.js";

/**
 * Shape we persist to disk. Kept structural (not @pim/sdk's SessionContext)
 * so loaders don't need the SDK at parse time.
 */
export interface SessionContextFixture {
  podId: string;
  pulledAt: string;
  /** Org slug used when fetching live PIM/KG data for this fixture. */
  sourceOrgSlug?: string;
  /**
   * Point-in-time cutoff this fixture was scoped to (ISO). Set by
   * `filterFixtureByAsOf`; absent on the raw pod fixture. The temporal audit
   * validates each scoped fixture's timestamps against this.
   */
  asOf?: string;
  /** The SessionContext payload as returned by PimClient.pullSessionContext(). */
  payload: {
    pod: { pod_id: string; name: string; milestone?: { name: string }; conflict_pressure?: number; areas?: unknown[] };
    livingDocMarkdown: string;
    /**
     * Section-level point-in-time provenance for the living doc. When present,
     * `filterFixtureByAsOf` filters these sections and rebuilds
     * `livingDocMarkdown`, so the temporal audit can prove the living doc did not
     * leak post-asOf content.
     */
    livingDocSections?: LivingDocSection[];
    conflicts: Array<{
      id: string;
      summary: string;
      severity: string;
      status: string;
      sides: Array<{ contributor: string; position: string }>;
      master_analysis: string;
      impact: string[];
      /**
       * ISO creation timestamp, when the freezer records it. Used by
       * `filterFixtureByAsOf` for point-in-time scoping. Absent on seed fixtures,
       * in which case the conflict passes through unfiltered (known limitation).
       */
      created_at?: string;
    }>;
    relevantLearnings: FixtureLearnings;
    /**
     * Optional task-scoped KG retrieval produced by the eval freezer. Older
     * fixtures only have the pod-level `relevantLearnings`; arms must fall
     * back to that block when a task key is absent.
     */
    taskRelevantLearnings?: Record<string, FixtureLearnings>;
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

export interface LivingDocSection {
  heading: string;
  markdown: string;
  /** ISO timestamp for when this section's content became valid. */
  updated_at: string;
  /** Optional provenance note for auditors. */
  source?: string;
}

export interface FixtureLearnings {
  nodes: Array<{
    type: string;
    summary: string;
    details: string;
    domains: string[];
    confidence_score: number;
    source_pod_name?: string;
    /**
     * ISO creation timestamp, when the freezer records it. Used by
     * `filterFixtureByAsOf` for point-in-time scoping. Absent on seed fixtures,
     * in which case the node passes through unfiltered (known limitation).
     */
    created_at?: string;
  }>;
  total_matching: number;
  truncated: boolean;
}

/**
 * lic code-intelligence fixture frozen to disk by `lic-freeze`
 * (packages/eval/fixtures/lic/<taskId>.json). Arms consume `renderedBlock`,
 * a pre-rendered, budget-clipped markdown block of lic search hits, symbol
 * references, and call-graph excerpts for the task.
 */
export interface LicContextFixture {
  taskId: string;
  stratum?: string;
  renderedBlock: string;
  renderedBlockHash?: string;
  generatedAt?: string;
  recipe?: string[];
  indexSource?: LicIndexSource;
  quality?: LicFixtureQuality;
}

export type LicIndexSource =
  | { kind: "head"; repo: string }
  | { kind: "parentSha"; sha: string; worktree: string };

/**
 * Inputs an arm may consume via `buildWithInputs`. Either fixture may be null
 * when not frozen for the task; the arm decides whether that is fatal.
 */
export interface ArmBuildInputs {
  pim: SessionContextFixture | null;
  lic: LicContextFixture | null;
}

export interface Arm {
  readonly id: string;
  readonly label: string;
  /** Whether this arm injects PIM context (treatment) or not (control). */
  readonly usesPim: boolean;
  /** Whether this arm injects a lic code-intelligence block. */
  readonly usesLic?: boolean;
  /** Marks an arm as part of the protocol's primary (vs. exploratory) comparison. */
  readonly primary?: boolean;
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments;
  /**
   * Richer entrypoint for arms that need lic (or both PIM and lic) fixtures.
   * When present, the runner calls this instead of `build`. Arms that only need
   * the PIM fixture can omit it and rely on `build`.
   */
  buildWithInputs?(task: Task, inputs: ArmBuildInputs): PromptSegments;
}
