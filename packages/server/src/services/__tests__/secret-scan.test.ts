import { describe, it, expect } from "vitest";
import { scanForSecrets } from "../secret-scan.js";

describe("scanForSecrets", () => {
  it("passes clean text", () => {
    const result = scanForSecrets("Implemented the login form component");
    expect(result.clean).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("detects AWS access keys", () => {
    const result = scanForSecrets("key = AKIAIOSFODNN7EXAMPLE");
    expect(result.clean).toBe(false);
    expect(result.findings).toContain("AWS Access Key");
  });

  it("detects JWT tokens", () => {
    const result = scanForSecrets(
      "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl",
    );
    expect(result.clean).toBe(false);
    expect(result.findings).toContain("JWT Token");
  });

  it("detects connection strings", () => {
    const result = scanForSecrets("postgres://user:pass@host:5432/db");
    expect(result.clean).toBe(false);
    expect(result.findings).toContain("Connection String");

    const mongo = scanForSecrets("mongodb://admin:secret@cluster0.example.net/mydb");
    expect(mongo.clean).toBe(false);
  });

  it("detects PEM private keys", () => {
    const result = scanForSecrets(
      "-----BEGIN RSA PRIVATE KEY-----\nZmFrZS1wcml2YXRlLWtleQ==\n-----END RSA PRIVATE KEY-----",
    );
    expect(result.clean).toBe(false);
    expect(result.findings).toContain("PEM Private Key");
  });

  it("detects generic secret assignments", () => {
    const result = scanForSecrets('api_key = "sk_live_abc123defg456"');
    expect(result.clean).toBe(false);
    expect(result.findings).toContain("Generic Secret");
  });

  it("reports multiple findings at once", () => {
    const text = `
      key: AKIAIOSFODNN7EXAMPLE
      db: postgres://user:pass@host/db
    `;
    const result = scanForSecrets(text);
    expect(result.clean).toBe(false);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores short values that look like keys but aren't", () => {
    const result = scanForSecrets('password = "short"');
    expect(result.clean).toBe(true);
  });
});
