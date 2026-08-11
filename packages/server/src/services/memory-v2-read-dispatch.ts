import type {
  MemoryPlaneV2,
  MemoryRecordV2,
  MemoryRetrievalPackV2,
} from "@pim/shared";
import db from "../db/connection.js";
import {
  getAuthorizedCodeMemoryRecordV2,
  getAuthorizedCodeMemoryPackV2,
} from "./memory-v2-code-read.js";
import {
  getAuthorizedHarnessMemoryPackV2,
  getAuthorizedHarnessMemoryRecordV2,
} from "./memory-v2-harness-read.js";
import {
  MemoryV2ReadCoreError,
  type MemoryV2ReadErrorCode,
} from "./memory-v2-read-core.js";
import { memoryV2RepositoryResourceRowId } from "./memory-v2-resources.js";
import {
  authorizeMemoryV2Request,
  type AuthorizedMemoryV2ResourceContext,
  type MemoryV2RequestAuthorizationSnapshot,
} from "./memory-v2-request-authorization.js";
import {
  MEMORY_V2_PLANES,
  requiredMemoryV2Scope,
  type MemoryV2Operation,
} from "./memory-v2-constants.js";

export class MemoryV2ReadDispatchError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: MemoryV2ReadErrorCode,
    readonly plane?: MemoryPlaneV2,
    readonly details: Array<{ path: string; reason: string }> = [],
  ) {
    super(message);
    this.name = "MemoryV2ReadDispatchError";
  }
}

function dispatchPlaneRead<T>(plane: "codebase" | "harness", read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof MemoryV2ReadCoreError)) throw error;
    const concealResource = error.code === "resource_binding_mismatch";
    throw new MemoryV2ReadDispatchError(
      concealResource
        ? "Memory resource is unavailable"
        : error.statusCode >= 500
          ? "Memory service is temporarily unavailable"
          : error.message,
      concealResource ? 404 : error.statusCode,
      concealResource ? "resource_not_found" : error.code,
      plane,
      concealResource ? [] : error.details,
    );
  }
}

function assertAnyReadScope(
  principal: MemoryV2RequestAuthorizationSnapshot,
  operation: "detail" | "pack",
): void {
  const authorized = MEMORY_V2_PLANES.some((plane) => {
    const required = requiredMemoryV2Scope(plane, operation);
    return required !== null && principal.scopes.some((scope) => scope === required);
  });
  if (!authorized) {
    throw new MemoryV2ReadDispatchError(
      "The required memory read scope is not authorized",
      403,
      "scope_required",
    );
  }
}

function authorizeOpaqueRead(input: {
  principal: MemoryV2RequestAuthorizationSnapshot;
  plane: "codebase" | "harness";
  operation: MemoryV2Operation;
  resourceRowId: string;
  notFoundMessage: string;
}): AuthorizedMemoryV2ResourceContext {
  const exactResourceIsBound = input.principal.resources.some((resource) => (
    resource.resourceRowId === input.resourceRowId
    && resource.resource.plane === input.plane
  ));
  if (!exactResourceIsBound) {
    throw new MemoryV2ReadDispatchError(
      input.notFoundMessage,
      404,
      "resource_not_found",
    );
  }
  const decision = authorizeMemoryV2Request({
    principal: input.principal,
    operation: input.operation,
    plane: input.plane,
    orgId: input.principal.orgId,
    projectId: input.principal.projectId!,
    resourceRowId: input.resourceRowId,
  });
  if (decision.decision === "allow") return decision.context;
  if (decision.reason === "scope_missing") {
    throw new MemoryV2ReadDispatchError(
      "The required memory scope is unavailable",
      403,
      "scope_required",
      input.plane,
    );
  }
  throw new MemoryV2ReadDispatchError(
    input.notFoundMessage,
    404,
    "resource_not_found",
  );
}

/** Authorize eligible detail resources before resolving one immutable record/facet. */
export function getMemoryRecordV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  recordId: string;
  recordVersion: number;
}): MemoryRecordV2 {
  const principal = input.principal;
  if (!principal) {
    throw new MemoryV2ReadDispatchError(
      "A PIM service-token principal is required",
      401,
      "authentication_required",
    );
  }
  if (!principal.projectId || principal.podId) {
    throw new MemoryV2ReadDispatchError(
      "A project-bound PIM service-token principal is required",
      403,
      "resource_binding_mismatch",
    );
  }
  assertAnyReadScope(principal, "detail");
  const row = db.prepare(
    `SELECT record.plane AS record_plane, record.repository_row_id,
            record.harness_id, facet.plane AS facet_plane, facet.resource_row_id
     FROM memory_records AS record
     INNER JOIN memory_record_versions AS version
       ON version.record_id = record.record_id AND version.record_version = ?
     LEFT JOIN memory_v2_record_facets AS facet
       ON facet.record_id = version.record_id
      AND facet.record_version = version.record_version
     WHERE record.org_id = ? AND record.project_id = ? AND record.record_id = ?`,
  ).get(
    input.recordVersion,
    principal.orgId,
    principal.projectId,
    input.recordId,
  ) as {
    record_plane: string;
    repository_row_id: string | null;
    harness_id: string | null;
    facet_plane: string | null;
    resource_row_id: string | null;
  } | undefined;
  if (!row) {
    throw new MemoryV2ReadDispatchError(
      "Memory record is unavailable",
      404,
      "resource_not_found",
    );
  }
  if (!row.resource_row_id) {
    const expectedResourceRowId = row.record_plane === "codebase" && row.repository_row_id
      ? memoryV2RepositoryResourceRowId(row.repository_row_id)
      : null;
    const sourceIsBound = principal.resources.some((resource) => (
      (expectedResourceRowId !== null && resource.resourceRowId === expectedResourceRowId)
      || (row.record_plane === "harness"
        && row.harness_id !== null
        && resource.resource.plane === "harness"
        && resource.resource.canonicalResourceId === row.harness_id)
    ));
    if (sourceIsBound) {
      throw new MemoryV2ReadDispatchError(
        "Memory service is temporarily unavailable",
        503,
        "temporarily_unavailable",
        row.record_plane === "codebase" || row.record_plane === "harness"
          ? row.record_plane
          : undefined,
      );
    }
    throw new MemoryV2ReadDispatchError(
      "Memory record is unavailable",
      404,
      "resource_not_found",
    );
  }
  const plane = row.record_plane === "codebase" || row.record_plane === "harness"
    ? row.record_plane
    : undefined;
  if (!plane || row.facet_plane !== plane) {
    throw new MemoryV2ReadDispatchError(
      "Canonical memory facet reconciliation is incomplete",
      503,
      "temporarily_unavailable",
      plane,
    );
  }
  const authorization = authorizeOpaqueRead({
    principal,
    plane,
    operation: "detail",
    resourceRowId: row.resource_row_id,
    notFoundMessage: "Memory record is unavailable",
  });
  return dispatchPlaneRead(plane, () => plane === "harness"
    ? getAuthorizedHarnessMemoryRecordV2({
      authorization,
      recordId: input.recordId,
      recordVersion: input.recordVersion,
    })
    : getAuthorizedCodeMemoryRecordV2({
      authorization,
      recordId: input.recordId,
      recordVersion: input.recordVersion,
    }));
}

/** Stored pack IDs are identifiers, so every generic read resolves and reauthorizes its plane. */
export function getMemoryPackV2(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  packId: string;
  now?: string;
}): MemoryRetrievalPackV2 {
  const principal = input.principal;
  if (!principal) {
    throw new MemoryV2ReadDispatchError(
      "A PIM service-token principal is required",
      401,
      "authentication_required",
    );
  }
  if (!principal.projectId || principal.podId) {
    throw new MemoryV2ReadDispatchError(
      "A project-bound PIM service-token principal is required",
      403,
      "resource_binding_mismatch",
    );
  }
  assertAnyReadScope(principal, "pack");
  const row = db.prepare(
    `SELECT plane, resource_row_id FROM memory_v2_retrieval_packs
     WHERE retrieval_pack_id = ? AND org_id = ? AND project_id = ?`,
  ).get(input.packId, principal.orgId, principal.projectId) as {
    plane: string;
    resource_row_id: string;
  } | undefined;
  if (!row) {
    throw new MemoryV2ReadDispatchError(
      "Memory retrieval pack is unavailable",
      404,
      "resource_not_found",
    );
  }
  if (row.plane !== "codebase" && row.plane !== "harness") {
    throw new MemoryV2ReadDispatchError(
      "Memory service is temporarily unavailable",
      503,
      "temporarily_unavailable",
    );
  }
  const authorization = authorizeOpaqueRead({
    principal,
    plane: row.plane,
    operation: "pack",
    resourceRowId: row.resource_row_id,
    notFoundMessage: "Memory retrieval pack is unavailable",
  });
  return dispatchPlaneRead(row.plane, () => row.plane === "harness"
    ? getAuthorizedHarnessMemoryPackV2({
      authorization,
      packId: input.packId,
      ...(input.now ? { now: input.now } : {}),
    })
    : getAuthorizedCodeMemoryPackV2({
      authorization,
      packId: input.packId,
      ...(input.now ? { now: input.now } : {}),
    }));
}
