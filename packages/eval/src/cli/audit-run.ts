import {
  analyzeRun,
  auditJudging,
  auditLeakage,
  auditRubrics,
  auditTemporal,
  writeReviewerPacket,
} from "../rigor/run-audits.js";
import { printAuditResult, type AuditResult } from "../rigor/protocol.js";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main(): Promise<void> {
  const type = argValue("type") ?? "leakage";
  const runDir = argValue("run-id") ?? argValue("run-dir");
  if (!runDir) throw new Error("--run-id=<run artifact dir> is required");

  let result: AuditResult = { ok: true, findings: [] };
  if (type === "temporal") result = await auditTemporal(runDir);
  else if (type === "leakage") result = await auditLeakage(runDir);
  else if (type === "rubrics") result = await auditRubrics(runDir);
  else if (type === "judging") result = await auditJudging(runDir);
  else if (type === "analyze") result = await analyzeRun(runDir);
  else if (type === "packet") {
    await writeReviewerPacket(runDir);
    result = { ok: true, findings: [] };
  } else {
    throw new Error(`unknown --type=${type}`);
  }

  printAuditResult(type === "analyze" ? "analyze" : `audit:${type}`, result);
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error("[audit-run] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
