// Deterministic regex-based secret detection (SPEC section 5.4)

const SECRET_PATTERNS = [
  { name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "AWS Secret Key", pattern: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{32,}["']?/i },
  { name: "JWT Token", pattern: /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/ },
  { name: "Connection String", pattern: /(postgres|mysql|mongodb|redis):\/\/[^\s"']+/ },
  {
    name: "PEM Private Key",
    pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/,
  },
  { name: "Slack Token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "GitHub Token", pattern: /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/ },
  // Explicit token boundaries prevent the `sk-` suffix in ordinary words such
  // as `risk-analysis-*` and `task-orchestration-*` from starting a match.
  // Underscore is intentionally allowed as a left-hand delimiter while it
  // remains part of the token alphabet on the right.
  { name: "OpenAI Key", pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/ },
  { name: "Bearer Token", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i },
  { name: "Generic Secret", pattern: /(secret|password|token|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: "Generic Secret", pattern: /(secret|password|token|api[_-]?key)\s*[:=]\s*[^\s,'";]{8,}/i },
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
