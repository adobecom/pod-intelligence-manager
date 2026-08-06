import { describe, expect, it } from "vitest";
import {
  normalizeProjectEvidence,
  normalizeProjectIndexContent,
  PROJECT_EVIDENCE_REDACTION_VERSION,
  ProjectEvidenceNormalizationError,
} from "../project-evidence-normalization.js";

describe("project evidence canonical normalization", () => {
  it("uses the v2 policy and preserves identifiers that contain ordinary sk suffixes", () => {
    const values = [
      "risk-analysis-dashboard-update",
      "task-orchestration-migration-strategy",
    ];
    for (const value of values) {
      const normalized = normalizeProjectEvidence({
        source: "jira",
        source_type: "issue",
        source_id: value,
        native_id: value,
        source_title: value,
        summary: value,
        body: value,
      });
      expect(PROJECT_EVIDENCE_REDACTION_VERSION).toBe("project-evidence-v2");
      expect(normalized.redaction_version).toBe("project-evidence-v2");
      expect(normalized.source_id).toBe(value);
      expect(normalized.native_id).toBe(value);
      expect(normalized.source_title).toBe(value);
      expect(normalized.body).toBe(value);
      expect(normalized.findings).not.toContain("OpenAI Key");
    }
  });

  it("redacts every persisted field, allowlists connector metadata, and hashes deterministically", () => {
    const raw = {
      source: "slack" as const,
      source_type: "thread",
      source_id: "workspace-a:C123:1710000.001",
      source_instance: "workspace-a",
      native_id: "C123:1710000.001",
      source_version: "v2",
      source_url: "https://slack.example/archives/C123?thread_ts=1710000.001&token=topsecretvalue",
      source_title: "Incident token = topsecretvalue",
      summary: "Use the incident runbook",
      body: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      author: "bot",
      metadata: {
        workspace_id: "T123",
        channel_id: "C123",
        thread_ts: "1710000.001",
        binding_key: "slack:T123:C123",
        ignored_raw_payload: "must not persist",
        reactions: [{ name: "eyes", token: "nestedsecretvalue" }],
      },
      visibility: "project_visible" as const,
      visibility_version: "public-v1",
    };

    const first = normalizeProjectEvidence(raw);
    const second = normalizeProjectEvidence(raw);
    const persisted = JSON.stringify(first);

    expect(first.redaction_version).toBe(PROJECT_EVIDENCE_REDACTION_VERSION);
    expect(first.normalized_content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.normalized_content_hash).toBe(second.normalized_content_hash);
    expect(first.metadata).toMatchObject({
      workspace_id: "T123",
      channel_id: "C123",
      thread_ts: "1710000.001",
      binding_key: "slack:T123:C123",
    });
    expect(first.metadata).not.toHaveProperty("ignored_raw_payload");
    expect(persisted).not.toContain("topsecretvalue");
    expect(persisted).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(persisted).not.toContain("nestedsecretvalue");
    expect(first.findings).toEqual(expect.arrayContaining(["Bearer Token", "Generic Secret", "URL Credential"]));
  });

  it("redacts direct-index comments and permission values", () => {
    const normalized = normalizeProjectIndexContent({
      source: "confluence",
      source_type: "section",
      source_id: "site-a::page-1#overview",
      source_instance: "site-a",
      native_id: "page-1#overview",
      title: "Overview",
      body: "Safe body",
      comments: ['api_key = "sk_live_abc123defg456"'],
      metadata: { site_id: "site-a", page_id: "page-1", heading: "Overview" },
      permissions: { note: "Bearer abcdefghijklmnopqrstuvwxyz" },
      visibility: "project_visible",
    });

    expect(JSON.stringify(normalized)).not.toContain("sk_live_abc123defg456");
    expect(JSON.stringify(normalized)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(normalized.permissions.visibility).toBe("project_visible");
  });

  it("scrubs credentials from URLs embedded in persisted text", () => {
    const normalized = normalizeProjectIndexContent({
      source: "slack",
      source_type: "thread",
      source_id: "thread-with-links",
      title: "Debug links",
      body: "Open https://user:super-password@example.test/path?sig=signing-value&client_secret=client-value&view=ok",
      comments: [
        "Retry https://example.test/callback?access_token=opaque-value&refresh_token=refresh-value&x-amz-signature=aws-signature-value&x-goog-signature=goog-signature-value",
      ],
      visibility: "project_visible",
    });
    const persisted = JSON.stringify(normalized);

    expect(persisted).not.toContain("super-password");
    expect(persisted).not.toContain("signing-value");
    expect(persisted).not.toContain("opaque-value");
    expect(persisted).not.toContain("client-value");
    expect(persisted).not.toContain("refresh-value");
    expect(persisted).not.toContain("aws-signature-value");
    expect(persisted).not.toContain("goog-signature-value");
    expect(normalized.findings).toContain("URL Credential");
  });

  it("redacts credentials in nested metadata keys and complete token/key blocks", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.signature-must-disappear";
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END RSA PRIVATE KEY-----";
    const normalized = normalizeProjectEvidence({
      source: "slack",
      source_type: "thread",
      source_id: "thread-secrets",
      source_title: "Security sample",
      summary: "Security sample",
      body: `${jwt}\n${pem}`,
      metadata: {
        reactions: {
          "token_ghp_abcdefghijklmnopqrstuvwxyz": 1,
          eyes: 2,
        },
      },
    });
    const persisted = JSON.stringify(normalized);

    expect(persisted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(persisted).not.toContain("signature-must-disappear");
    expect(persisted).not.toContain("YWJjZGVmZ2hpamtsbW5vcA");
    expect(persisted).not.toContain("END RSA PRIVATE KEY");
    expect(normalized.findings).toEqual(expect.arrayContaining(["Metadata Credential", "JWT Token", "PEM Private Key"]));
  });

  it("fails closed on cyclic metadata", () => {
    const metadata: Record<string, unknown> = {};
    metadata.reactions = metadata;
    expect(() => normalizeProjectEvidence({
      source: "slack",
      source_type: "thread",
      source_id: "thread-1",
      source_title: "Thread",
      summary: "Summary",
      body: "Body",
      metadata,
    })).toThrow(ProjectEvidenceNormalizationError);
  });
});
