import { describe, expect, it } from "vitest";
import {
  compileSkillLayout,
  deriveSkillNamespace,
  SkillCatalogLayoutError,
} from "../skill-catalog-layout.js";
import { parseSkillMarkdown } from "../skill-catalog-markdown.js";

describe("skill catalog layout rules", () => {
  const layout = compileSkillLayout(
    [
      {
        glob: "projects/*/skills/**/*.md",
        namespace: "project:{1}",
      },
      {
        glob: "shared/skills/**/*.md",
        namespace: "shared",
      },
    ],
    ["projects/*/skills/**/context-*.md"],
  );

  it("derives captured project and shared namespaces", () => {
    expect(
      deriveSkillNamespace("projects/greenfield/skills/review.md", layout),
    ).toBe("project:greenfield");
    expect(
      deriveSkillNamespace(
        "projects/existing/skills/security/review.md",
        layout,
      ),
    ).toBe("project:existing");
    expect(deriveSkillNamespace("shared/skills/review.md", layout)).toBe(
      "shared",
    );
  });

  it("applies excludes before ordered layout rules", () => {
    expect(
      deriveSkillNamespace(
        "projects/example/skills/internal/context-review.md",
        layout,
      ),
    ).toBeNull();
    expect(deriveSkillNamespace("projects/example/README.md", layout)).toBeNull();
  });

  it("accepts the first skill in a namespace that is not cataloged yet", () => {
    expect(
      deriveSkillNamespace("projects/brand-new/skills/first.md", layout),
    ).toBe("project:brand-new");
  });

  it("rejects namespace placeholders without a wildcard capture", () => {
    expect(() =>
      compileSkillLayout([
        { glob: "shared/skills/*.md", namespace: "project:{2}" },
      ]),
    ).toThrow(SkillCatalogLayoutError);
  });
});

describe("skill Markdown metadata extraction", () => {
  it("reads quoted and folded frontmatter fields", () => {
    const parsed = parseSkillMarkdown(
      "projects/example/skills/SKILL.md",
      [
        "---",
        "name: 'PR Review'",
        "description: >-",
        "  Reviews pull requests for",
        "  correctness and security.",
        "---",
        "# Ignored fallback",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      normalizedName: "pr-review",
      description: "Reviews pull requests for correctness and security.",
    });
  });

  it("falls back to the first heading and paragraph", () => {
    expect(
      parseSkillMarkdown(
        "shared/skills/SKILL.md",
        "# Release Audit\n\nChecks every release before publication.",
      ),
    ).toEqual({
      normalizedName: "release-audit",
      description: "Checks every release before publication.",
    });
  });
});
