import { reverifyGithubMemoryRecord } from "./memory-attestations.js";
import {
  reverifyMemoryV2RuntimeRecord,
} from "./memory-v2-runtime-attestations.js";
import type {
  MemoryV2ReverificationProvider,
  MemoryV2ReverificationProviderContext,
  MemoryV2ReverificationProviderResult,
} from "./memory-v2-reverification.js";

function unsupportedResolver(
  context: MemoryV2ReverificationProviderContext,
): MemoryV2ReverificationProviderResult {
  const supported = (context.plane === "codebase" && context.resolverType === "github")
    || (context.plane === "harness" && context.resolverType === "runtime_attestation");
  return {
    outcome: "unavailable",
    errorCode: supported
      ? "authoritative_source_unavailable"
      : "resolver_scope_mismatch",
  };
}

/** Concrete production dispatcher for the only two implemented v2 planes. */
export const memoryV2ProductionReverificationProvider: MemoryV2ReverificationProvider = async (
  context,
) => {
  try {
    if (context.plane === "codebase" && context.resolverType === "github") {
      return await reverifyGithubMemoryRecord({
        recordId: context.recordId,
        recordVersion: context.recordVersion,
        orgId: context.orgId,
        projectId: context.projectId,
        resourceRowId: context.resourceRowId,
        attemptedAt: context.attemptedAt,
      });
    }
    if (context.plane === "harness" && context.resolverType === "runtime_attestation") {
      return await reverifyMemoryV2RuntimeRecord({
        recordId: context.recordId,
        recordVersion: context.recordVersion,
        orgId: context.orgId,
        projectId: context.projectId,
        resourceRowId: context.resourceRowId,
        attemptedAt: context.attemptedAt,
      });
    }
    return unsupportedResolver(context);
  } catch {
    // Provider failures are data, never worker crashes. The worker owns retry,
    // grace, and fail-closed lifecycle decisions.
    return unsupportedResolver(context);
  }
};
