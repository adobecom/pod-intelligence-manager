import { randomUUID } from "node:crypto";
import db, { withImmediateTransaction } from "../db/connection.js";
import {
  projectMemoryV2HarnessPrincipalBinding,
  projectMemoryV2HarnessResource,
} from "./memory-v2-resources.js";

export interface MemoryHarnessPrincipalBinding {
  bindingId: string;
  servicePrincipalId: string;
  orgId: string;
  projectId: string;
  harnessId: string;
}

interface BindingRow {
  binding_id: string;
  service_principal_id: string;
  org_id: string;
  project_id: string;
  harness_id: string;
}

function toBinding(row: BindingRow): MemoryHarnessPrincipalBinding {
  return {
    bindingId: row.binding_id,
    servicePrincipalId: row.service_principal_id,
    orgId: row.org_id,
    projectId: row.project_id,
    harnessId: row.harness_id,
  };
}

export function resolveMemoryHarnessPrincipalBinding(input: {
  servicePrincipalId: string;
  orgId: string;
  projectId: string;
  harnessId: string;
}): MemoryHarnessPrincipalBinding | null {
  const row = db.prepare(
    `SELECT binding_id, service_principal_id, org_id, project_id, harness_id
     FROM memory_harness_principal_bindings
     WHERE service_principal_id = ? AND org_id = ? AND project_id = ? AND harness_id = ?`,
  ).get(
    input.servicePrincipalId,
    input.orgId,
    input.projectId,
    input.harnessId,
  ) as BindingRow | undefined;
  return row ? toBinding(row) : null;
}

/** Administrative provisioning helper; bindings are immutable once created. */
export function createMemoryHarnessPrincipalBinding(input: {
  servicePrincipalId: string;
  orgId: string;
  projectId: string;
  harnessId: string;
  now?: string;
}): MemoryHarnessPrincipalBinding {
  if (!input.harnessId || input.harnessId !== input.harnessId.trim() || input.harnessId.length > 64) {
    throw new Error("Harness binding requires an exact 1 to 64 character harness_id");
  }
  return withImmediateTransaction(() => {
    const principal = db.prepare(
      `SELECT 1 FROM service_principals
       WHERE service_principal_id = ? AND org_id = ? AND disabled_at IS NULL`,
    ).get(input.servicePrincipalId, input.orgId);
    const project = db.prepare(
      "SELECT 1 FROM projects WHERE project_id = ? AND org_id = ?",
    ).get(input.projectId, input.orgId);
    if (!principal || !project) throw new Error("Harness binding principal or project is unavailable");

    const existing = resolveMemoryHarnessPrincipalBinding(input);
    if (existing) {
      projectMemoryV2HarnessResource({
        orgId: input.orgId,
        projectId: input.projectId,
        harnessId: input.harnessId,
      });
      return existing;
    }
    const bindingId = `harness_binding_${randomUUID()}`;
    db.prepare(
      `INSERT INTO memory_harness_principal_bindings
         (binding_id, service_principal_id, org_id, project_id, harness_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      bindingId,
      input.servicePrincipalId,
      input.orgId,
      input.projectId,
      input.harnessId,
      input.now ?? new Date().toISOString(),
    );
    projectMemoryV2HarnessResource({
      orgId: input.orgId,
      projectId: input.projectId,
      harnessId: input.harnessId,
    });
    projectMemoryV2HarnessPrincipalBinding(bindingId);
    return resolveMemoryHarnessPrincipalBinding(input)!;
  });
}
