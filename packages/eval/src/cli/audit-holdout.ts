import { auditHoldout } from "../rigor/holdout.js";
import { printAuditResult } from "../rigor/protocol.js";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main(): Promise<void> {
  const holdout = argValue("holdout") ?? "holdouts/holdout-haiku-v2.json";
  const result = await auditHoldout(holdout);
  printAuditResult("audit:holdout", result);
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error("[audit:holdout] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
