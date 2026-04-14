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
