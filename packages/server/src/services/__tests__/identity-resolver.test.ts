import { describe, it, expect } from "vitest";
import { detectPersonTokens, stripActivityPhrasing } from "../identity-resolver.js";

describe("detectPersonTokens", () => {
  it("picks out an email in free text", () => {
    const r = detectPersonTokens("what has rea01581@adobe.com been up to");
    expect(r.email).toBe("rea01581@adobe.com");
    expect(r.is_activity_query).toBe(true);
    expect(r.cleaned_query).toBe("what has been up to");
  });

  it("picks out a Slack user id", () => {
    const r = detectPersonTokens("what has U02C5ESQM38 been up to");
    expect(r.slack_user_id).toBe("U02C5ESQM38");
    expect(r.email).toBeUndefined();
    expect(r.is_activity_query).toBe(true);
  });

  it("returns undefined when no identifier present", () => {
    const r = detectPersonTokens("has T3 Events completed their RBAC implementation");
    expect(r.email).toBeUndefined();
    expect(r.slack_user_id).toBeUndefined();
    expect(r.is_activity_query).toBe(false);
  });

  it("detects activity phrasing without a token", () => {
    const r = detectPersonTokens("what is Rayyan working on this week");
    expect(r.is_activity_query).toBe(true);
  });

  it("does not confuse uppercase words that start with U with Slack IDs", () => {
    const r = detectPersonTokens("UPDATE the URL patterns");
    expect(r.slack_user_id).toBeUndefined();
  });

  it("flags noun-phrase activity queries like 'X recent activity'", () => {
    const r = detectPersonTokens("rea01581@adobe.com recent activity");
    expect(r.email).toBe("rea01581@adobe.com");
    expect(r.is_activity_query).toBe(true);
  });

  it("flags 'latest commits' as an activity query", () => {
    const r = detectPersonTokens("rayyank10 latest commits");
    expect(r.is_activity_query).toBe(true);
  });
});

describe("stripActivityPhrasing", () => {
  it("strips actor tokens and activity nouns from a recent-activity query", () => {
    const out = stripActivityPhrasing(
      "rea01581@adobe.com recent activity",
      { email: "rea01581@adobe.com", display_name: "Rayyan Khan" },
    );
    expect(out).toBe("");
  });

  it("strips verb-phrase activity questions", () => {
    const out = stripActivityPhrasing(
      "what has Rayyan Khan been up to this week",
      { display_name: "Rayyan Khan" },
    );
    expect(out).toBe("");
  });

  it("preserves the residual subject when one exists", () => {
    const out = stripActivityPhrasing(
      "recent activity on the auth refactor",
      undefined,
    );
    expect(out.toLowerCase()).toContain("auth refactor");
  });
});
