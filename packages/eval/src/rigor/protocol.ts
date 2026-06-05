import { readFile } from "node:fs/promises";

const REQUIRED_PHRASES_HAIKU_V2 = [
  "Null Hypothesis",
  "Primary Outcome",
  "paired per-task pass-rate delta",
  "paired bootstrap with B = 10,000",
  "Minimum N",
  "at least 30 tasks",
  "Strong support",
  "No supported effect",
  "Harm",
  "length-matched-neutral as primary baseline",
  "pim-full",
  "kg-only",
  "lic-full",
  "lic-pim-combined",
  "Cohen",
  "0.6",
  "Benjamini-Hochberg",
  "severe-regression rate",
  "frozen lic snapshots",
  "per-stratum exploratory only",
  "S7 content-gen excluded",
  "lic structurally has the answer by construction",
  "under 1pp residual leakage",
  "Efficiency diagnostics",
  "worktree-per-asOf for all real headline strata",
  "locally indexed code",
  "realistic-ticket",
  "executable patch judge",
];

function selectRequiredPhrases(path: string): string[] {
  if (!path.includes("pim-vs-lic-haiku-v2")) {
    throw new Error(`unsupported protocol path: ${path}; active protocol is pim-vs-lic-haiku-v2`);
  }
  return REQUIRED_PHRASES_HAIKU_V2;
}

export interface AuditFinding {
  level: "error" | "warning";
  message: string;
}

export interface AuditResult {
  ok: boolean;
  findings: AuditFinding[];
}

export async function auditProtocol(path: string): Promise<AuditResult> {
  const text = await readFile(path, "utf8");
  const findings: AuditFinding[] = [];
  const required = selectRequiredPhrases(path);
  for (const phrase of required) {
    if (!text.includes(phrase)) {
      findings.push({ level: "error", message: `protocol missing required phrase: ${phrase}` });
    }
  }
  if (/cost[- ]per[- ]correct/i.test(text) && !/Efficiency diagnostics/i.test(text)) {
    findings.push({ level: "error", message: "cost appears outside an efficiency-diagnostics framing" });
  }
  return { ok: findings.every((f) => f.level !== "error"), findings };
}

export function printAuditResult(name: string, result: AuditResult): void {
  if (result.findings.length === 0) {
    console.log(`[${name}] ok`);
    return;
  }
  for (const finding of result.findings) {
    const prefix = finding.level === "error" ? "ERROR" : "WARN";
    console.log(`[${name}] ${prefix}: ${finding.message}`);
  }
}
