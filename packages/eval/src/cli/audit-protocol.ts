import { auditProtocol, printAuditResult } from "../rigor/protocol.js";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

async function main(): Promise<void> {
  const protocol = argValue("protocol") ?? "protocols/pim-vs-lic-haiku-v2.md";
  const result = await auditProtocol(protocol);
  printAuditResult("audit:protocol", result);
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error("[audit:protocol] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
