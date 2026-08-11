import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../db/connection.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import {
  assertMemoryV2StartupReconciled,
  reconcileMemoryV2Reverification,
} from "../memory-v2-startup-reconciliation.js";
import {
  reconcileMemoryV2ReverificationAdmissions,
} from "../memory-v2-reverification-admission.js";
import {
  runMemoryV2ReverificationPass,
} from "../memory-v2-reverification.js";
import { getMemoryV2RecordTrust } from "../memory-v2-trust.js";

const CUTOVER_AT = "2026-08-07T18:00:00.000Z";

let context: MemoryTestContext;
let previousEnabled: string | undefined;

beforeAll(async () => {
  previousEnabled = process.env.MEMORY_V2_REVERIFICATION_ENABLED;
  delete process.env.MEMORY_V2_REVERIFICATION_ENABLED;
  context = await createMemoryTestContext();

  const trust = getMemoryV2RecordTrust(context.seededRecordId, 1)!;
  db.prepare(
    "DELETE FROM memory_v2_record_trust WHERE record_id = ? AND record_version = 1",
  ).run(context.seededRecordId);
  db.prepare(
    `INSERT INTO memory_v2_record_trust (
       record_id, record_version, org_id, project_id, plane, resource_row_id,
       trust_status, trust_basis, cutover_decided_at, evidence_verified_at,
       created_at, updated_at
     ) VALUES (?, 1, ?, ?, ?, ?, 'trusted', 'legacy_cutover', ?, NULL, ?, ?)`,
  ).run(
    trust.recordId,
    trust.orgId,
    trust.projectId,
    trust.plane,
    trust.resourceRowId,
    CUTOVER_AT,
    CUTOVER_AT,
    CUTOVER_AT,
  );
});

afterAll(async () => {
  if (context) await context.app.close();
  if (previousEnabled === undefined) delete process.env.MEMORY_V2_REVERIFICATION_ENABLED;
  else process.env.MEMORY_V2_REVERIFICATION_ENABLED = previousEnabled;
});

describe.sequential("memory v2 reverification startup reconciliation", () => {
  it("accepts exact legacy-cutover trust without fabricating policy or verification state", async () => {
    expect(getMemoryV2RecordTrust(context.seededRecordId, 1)).toMatchObject({
      trustStatus: "trusted",
      trustBasis: "legacy_cutover",
      cutoverDecidedAt: CUTOVER_AT,
      evidenceVerifiedAt: null,
    });
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_reverification_state WHERE record_id = ?",
    ).get(context.seededRecordId)).toBeUndefined();

    expect(reconcileMemoryV2Reverification()).toMatchObject({
      uncoveredInfluenceRecordCount: 0,
      graphMismatchCount: 0,
      digestMismatchCount: 0,
      foreignKeyViolationCount: 0,
      ok: true,
    });
    expect(assertMemoryV2StartupReconciled().reverification.ok).toBe(true);
    expect(reconcileMemoryV2ReverificationAdmissions()).toMatchObject({
      eligibleRecordCount: 0,
      missingRecordCount: 0,
      admittedRecordCount: 0,
    });
    expect(await runMemoryV2ReverificationPass()).toMatchObject({
      enabled: false,
      scheduled: 0,
      claimed: 0,
    });
  });

  it("does not auto-enroll legacy cutover when reverification is enabled", () => {
    process.env.MEMORY_V2_REVERIFICATION_ENABLED = "1";
    const result = reconcileMemoryV2ReverificationAdmissions({
      createdBy: "startup-reconciliation-test",
    });
    expect(result.admittedRecordCount).toBeGreaterThanOrEqual(0);
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_reverification_state WHERE record_id = ?",
    ).get(context.seededRecordId)).toBeUndefined();
    expect(getMemoryV2RecordTrust(context.seededRecordId, 1)).toMatchObject({
      trustStatus: "trusted",
      trustBasis: "legacy_cutover",
    });
  });
});
