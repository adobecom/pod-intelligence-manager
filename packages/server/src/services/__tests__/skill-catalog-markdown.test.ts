import { describe, expect, it } from "vitest";
import { buildRedactedSkillEmbeddingText } from "../skill-catalog-markdown.js";

describe("skill catalog embedding text", () => {
  it("matches the spike shape without embedding the full skill body", () => {
    const text = [
      "---",
      "name: PR_Review",
      "description: Reviews pull requests for correctness and security.",
      "---",
      "# Pull Request Review",
      "",
      "THIS INSTRUCTION BODY MUST NOT BE EMBEDDED.",
      "",
      "## When to use",
      "",
      "Run this before merging a pull request.",
      "",
      "### Workflow",
      "",
      "Inspect the diff and rank findings.",
      "",
      "#### Implementation details",
      "",
      "Do not add implementation prose to retrieval text.",
      "",
      "```markdown",
      "## Not a real heading",
      "```",
    ].join("\n");

    const result = buildRedactedSkillEmbeddingText(
      "projects/example/skills/review.md",
      text,
    );

    expect(result).toBe(
      [
        "pr review",
        "Pull Request Review",
        "Reviews pull requests for correctness and security.",
        "When to use",
        "Workflow",
      ].join("\n"),
    );
    expect(result).not.toContain("THIS INSTRUCTION BODY");
    expect(result).not.toContain("Inspect the diff");
    expect(result).not.toContain("Implementation details");
    expect(result).not.toContain("Not a real heading");
  });

  it("redacts secrets before the text can be stored or embedded", () => {
    const result = buildRedactedSkillEmbeddingText(
      "shared/skills/secure-review.md",
      [
        "---",
        "name: Secure Review",
        'description: Use token = "super-secret-value" before every review.',
        "---",
        "# Secure Review",
        "",
        '## password: "another-secret-value"',
      ].join("\n"),
    );

    expect(result).toContain("[REDACTED:Generic Secret]");
    expect(result).not.toContain("super-secret-value");
    expect(result).not.toContain("another-secret-value");
  });

  it("uses the first real paragraph when frontmatter has no description", () => {
    expect(
      buildRedactedSkillEmbeddingText(
        "shared/skills/release-audit.md",
        [
          "# Release Audit",
          "",
          "Checks every release before publication.",
          "",
          "Later instructions are not part of the description.",
          "",
          "## Output",
        ].join("\n"),
      ),
    ).toBe(
      [
        "release audit",
        "Release Audit",
        "Checks every release before publication.",
        "Output",
      ].join("\n"),
    );
  });

  it("uses validated candidate metadata overrides without including body prose", () => {
    expect(
      buildRedactedSkillEmbeddingText(
        "projects/example/skills/draft.md",
        [
          "# Body Title",
          "",
          "Body fallback description.",
          "",
          "## Workflow",
        ].join("\n"),
        {
          name: "Candidate_Name.md",
          description: 'Use token = "candidate-secret-value" safely.',
        },
      ),
    ).toBe(
      [
        "candidate name",
        "Body Title",
        "Use [REDACTED:Generic Secret] safely.",
        "Workflow",
      ].join("\n"),
    );
  });
});
