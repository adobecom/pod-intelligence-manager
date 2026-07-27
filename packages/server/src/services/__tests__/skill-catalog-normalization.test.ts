import { describe, expect, it } from "vitest";
import {
  hashNormalizedSkillContent,
  normalizeSkillContent,
  normalizeSkillName,
} from "@pim/shared/skill-catalog";
import { redactSecrets } from "../secret-scan.js";

describe("skill catalog normalization", () => {
  it.each([
    ["Code Review.md", "code-review"],
    ["CODE_review.MD", "code-review"],
    ["  code---review  ", "code-review"],
    [" code_review.md ", "code-review"],
    ["Ｃｏｄｅ＿Ｒｅｖｉｅｗ.md", "code-review"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeSkillName(input)).toBe(expected);
  });

  it("strips frontmatter, normalizes line endings, and ignores trailing whitespace", () => {
    const windows = [
      "---",
      "name: code-review",
      "description: ignored metadata",
      "---",
      "# Code Review  ",
      "",
      "Run checks.\t",
      "",
      "",
    ].join("\r\n");
    const unix = "# Code Review\n\nRun checks.";

    expect(normalizeSkillContent(windows)).toBe(unix);
    expect(hashNormalizedSkillContent(windows)).toBe(
      hashNormalizedSkillContent(unix),
    );
  });

  it("does not mistake an unterminated horizontal rule for frontmatter", () => {
    expect(normalizeSkillContent("---\n# Still content")).toBe(
      "---\n# Still content",
    );
  });

  it("hashes pre-redaction bytes", () => {
    const first = 'Use token = "abcdefgh-one"';
    const second = 'Use token = "abcdefgh-two"';

    expect(redactSecrets(first).text).toBe(redactSecrets(second).text);
    expect(hashNormalizedSkillContent(first)).not.toBe(
      hashNormalizedSkillContent(second),
    );
  });
});
