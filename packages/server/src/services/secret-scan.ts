// Deterministic regex-based secret detection (SPEC section 5.4)

const SECRET_PATTERNS = [
  { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "JWT Token", pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+/ },
  { name: "Connection String", pattern: /(postgres|mysql|mongodb|redis):\/\/[^\s"']+/ },
  { name: "PEM Private Key", pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { name: "Generic Secret", pattern: /(secret|password|token|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i },
];

export interface SecretScanResult {
  clean: boolean;
  findings: string[];
}

export function scanForSecrets(text: string): SecretScanResult {
  const findings: string[] = [];

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      findings.push(name);
    }
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}

// Same patterns, applied as replacements. Uses global variants so every match
// in the input is redacted, not just the first. Returns the redacted text plus
// the list of pattern names that fired (for logging / diagnostics).
export function redactSecrets(text: string): { text: string; findings: string[] } {
  if (!text) return { text, findings: [] };
  let out = text;
  const findings: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    if (globalPattern.test(out)) findings.push(name);
    globalPattern.lastIndex = 0;
    out = out.replace(globalPattern, `[REDACTED:${name}]`);
  }
  return { text: out, findings };
}
