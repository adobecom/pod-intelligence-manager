/**
 * Offline-only memory retention and erasure control.
 *
 * This script never runs from server startup. Applying a reviewed plan requires
 * its exact digest and an explicit confirmation that PIM is stopped.
 */
import fs from "node:fs";
import path from "node:path";
import {
  MEMORY_RETENTION_DATA_CLASSES,
  MemoryDataGovernanceError,
  applyMemoryErasurePlan,
  createMemoryRetentionPolicyVersion,
  placeMemoryLegalHold,
  planMemoryErasure,
  planMemoryRetention,
  releaseMemoryLegalHold,
  type MemoryErasureMethod,
  type MemoryErasurePlan,
  type MemoryGovernanceDataClass,
  type MemoryRetentionDataClass,
} from "../services/memory-data-governance.js";

const USAGE = `Usage:
  memory-retention policy-set --org ID [--project ID] --class CLASS --days N --actor ID --reason CODE
  memory-retention hold-place --org ID [--project ID] --class CLASS [--resource ID] --actor ID --reason CODE
  memory-retention hold-release --hold ID --actor ID --reason CODE
  memory-retention plan-retention --org ID [--project ID] --class CLASS --actor ID --reason CODE --out FILE
  memory-retention plan-erasure --org ID [--project ID] --class tenant|record [--record ID]
      --method physical_delete|field_redaction|crypto_shred --actor ID --reason CODE --out FILE
  memory-retention apply --plan FILE --expect-digest sha256:... --confirm-pim-stopped

Optional planning flags: --now ISO, --backup-retention-days N`;

function usage(): never {
  throw new MemoryDataGovernanceError("usage", USAGE);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

function required(name: string): string {
  return option(name) ?? usage();
}

function integerOption(name: string): number | undefined {
  const raw = option(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) usage();
  return value;
}

function retentionClass(value: string): MemoryRetentionDataClass {
  if (!MEMORY_RETENTION_DATA_CLASSES.includes(value as MemoryRetentionDataClass)) usage();
  return value as MemoryRetentionDataClass;
}

function governanceClass(value: string): MemoryGovernanceDataClass {
  if (value === "tenant") return value;
  return retentionClass(value);
}

function erasureMethod(value: string): MemoryErasureMethod {
  if (!["physical_delete", "field_redaction", "crypto_shred"].includes(value)) usage();
  return value as MemoryErasureMethod;
}

function writePlan(file: string, plan: MemoryErasurePlan): void {
  const target = path.resolve(file);
  fs.writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    plan_file: target,
    plan_digest: plan.plan_digest,
    target_count: plan.targets.length,
    warnings: plan.warnings,
    external_obligations: plan.external_obligations,
  }, null, 2)}\n`);
}

function readPlan(file: string): MemoryErasurePlan {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || (parsed as { schema_version?: unknown }).schema_version !== "pim.memory-erasure-plan.v1") {
    throw new MemoryDataGovernanceError("plan_invalid", "Plan file is not pim.memory-erasure-plan.v1");
  }
  return parsed as MemoryErasurePlan;
}

function sharedInput() {
  return {
    orgId: required("--org"),
    projectId: option("--project"),
    actorId: required("--actor"),
    reasonCode: required("--reason"),
    now: option("--now"),
  };
}

function main(): void {
  const positional = process.argv.slice(2);
  if (positional[0] === "--") positional.shift();
  const command = positional[0];
  if (command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!command) usage();

  if (command === "policy-set") {
    const result = createMemoryRetentionPolicyVersion({
      ...sharedInput(),
      dataClass: retentionClass(required("--class")),
      retentionDays: integerOption("--days") ?? usage(),
      effectiveAt: option("--effective-at"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "hold-place") {
    const result = placeMemoryLegalHold({
      ...sharedInput(),
      dataClass: governanceClass(required("--class")),
      resourceId: option("--resource"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "hold-release") {
    releaseMemoryLegalHold({
      holdId: required("--hold"),
      actorId: required("--actor"),
      reasonCode: required("--reason"),
      now: option("--now"),
    });
    process.stdout.write(`${JSON.stringify({ hold_id: required("--hold"), released: true }, null, 2)}\n`);
    return;
  }

  if (command === "plan-retention") {
    const plan = planMemoryRetention({
      ...sharedInput(),
      dataClass: retentionClass(required("--class")),
      backupRetentionDays: integerOption("--backup-retention-days"),
    });
    writePlan(required("--out"), plan);
    return;
  }

  if (command === "plan-erasure") {
    const dataClass = required("--class");
    if (dataClass !== "tenant" && dataClass !== "record") usage();
    const plan = planMemoryErasure({
      ...sharedInput(),
      dataClass,
      recordId: option("--record"),
      method: erasureMethod(required("--method")),
      backupRetentionDays: integerOption("--backup-retention-days"),
    });
    writePlan(required("--out"), plan);
    return;
  }

  if (command === "apply") {
    if (!process.argv.includes("--confirm-pim-stopped")) {
      throw new MemoryDataGovernanceError(
        "downtime_confirmation_required",
        "Refusing apply without --confirm-pim-stopped",
      );
    }
    const result = applyMemoryErasurePlan({
      plan: readPlan(required("--plan")),
      expectedPlanDigest: required("--expect-digest"),
      downtimeConfirmed: true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  usage();
}

try {
  main();
} catch (error) {
  const code = error instanceof MemoryDataGovernanceError ? error.code : "memory_retention_failed";
  const message = error instanceof Error ? error.message : "Memory retention failed";
  process.stderr.write(`${JSON.stringify({ error: code, message }, null, 2)}\n`);
  process.exitCode = 1;
}
