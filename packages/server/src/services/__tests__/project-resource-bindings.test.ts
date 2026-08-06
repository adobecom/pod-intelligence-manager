import { afterEach, describe, expect, it } from "vitest";
import type { ProjectResources } from "@pim/shared";
import {
  configuredGithubRepos,
  configuredJiraProjectKeys,
  connectorBindingVersion,
  hasGithubProjectBinding,
  hasJiraProjectBinding,
} from "../project-resource-bindings.js";

afterEach(() => {
  delete process.env.JIRA_BASE_URL;
  delete process.env.PROJECT_GITHUB_VISIBLE_REPOS;
  delete process.env.PROJECT_JIRA_VISIBLE_PROJECT_KEYS;
});

describe("database-backed project resource bindings", () => {
  it("uses canonical project resources without a duplicate operator environment allowlist", () => {
    const resources: ProjectResources = {
      github: { repos: ["Adobe/EMC", "adobe/event-libs", "adobe/EMC"] },
      jira: { project_keys: ["mwpw"] },
    };
    process.env.JIRA_BASE_URL = "https://jira.example.test/";

    const githubVersion = connectorBindingVersion(resources, "github");
    const jiraVersion = connectorBindingVersion(resources, "jira");

    expect(configuredGithubRepos(resources)).toEqual(["adobe/emc", "adobe/event-libs"]);
    expect(configuredJiraProjectKeys(resources)).toEqual(["MWPW"]);
    expect(hasGithubProjectBinding(resources)).toBe(true);
    expect(hasJiraProjectBinding(resources)).toBe(true);
    expect(githubVersion).toMatch(/^resource-binding-v1:/);
    expect(jiraVersion).toMatch(/^resource-binding-v1:/);

    // These legacy deployment values are deliberately ignored. Adding,
    // removing, or reordering them must not invalidate persisted evidence.
    process.env.PROJECT_GITHUB_VISIBLE_REPOS = "unrelated/repo,adobe/emc";
    process.env.PROJECT_JIRA_VISIBLE_PROJECT_KEYS = "OTHER,MWPW";
    expect(connectorBindingVersion(resources, "github")).toBe(githubVersion);
    expect(connectorBindingVersion(resources, "jira")).toBe(jiraVersion);
  });

  it("rejects Jira item bindings outside the configured project keys", () => {
    const resources: ProjectResources = {
      jira: { project_keys: ["MWPW"], issue_keys: ["OTHER-123"] },
    };

    expect(configuredJiraProjectKeys(resources)).toEqual([]);
    expect(hasJiraProjectBinding(resources)).toBe(false);
    expect(connectorBindingVersion(resources, "jira")).toBeNull();
  });
});
