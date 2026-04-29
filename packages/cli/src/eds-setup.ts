import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  MILO_BLOCKS_RULE,
  MILO_CODE_STYLE_RULE,
  MILO_ACCESSIBILITY_RULE,
  MILO_PERFORMANCE_RULE,
  MILO_FEATURES_RULE,
  MILO_TESTS_RULE,
  MILO_UTILS_RULE,
  EDS_POST_TOOL_HOOKS,
  EDS_PRE_TOOL_HOOKS,
  EDS_ALLOW_PERMISSIONS,
  EDS_DENY_PERMISSIONS,
} from "./templates/eds-rules.js";

const RULE_FILES: Array<{ name: string; content: string }> = [
  { name: "milo-blocks.md", content: MILO_BLOCKS_RULE },
  { name: "milo-code-style.md", content: MILO_CODE_STYLE_RULE },
  { name: "milo-accessibility.md", content: MILO_ACCESSIBILITY_RULE },
  { name: "milo-performance.md", content: MILO_PERFORMANCE_RULE },
  { name: "milo-features.md", content: MILO_FEATURES_RULE },
  { name: "milo-tests.md", content: MILO_TESTS_RULE },
  { name: "milo-utils.md", content: MILO_UTILS_RULE },
];

export function detectEdsProject(root: string): boolean {
  return (
    fs.existsSync(path.join(root, ".helix")) ||
    fs.existsSync(path.join(root, "fstab.yaml")) ||
    fs.existsSync(path.join(root, "aem.js")) ||
    (fs.existsSync(path.join(root, "blocks")) && fs.existsSync(path.join(root, "scripts")))
  );
}

export function runEdsSetup(root: string, claudeSettingsPath: string): void {
  console.log(chalk.bold("\n  EDS/Milo Tooling Setup\n"));

  // ── 1. Write rule files ─────────────────────────────────────────────────
  const rulesDir = path.join(path.dirname(claudeSettingsPath), "rules");
  fs.mkdirSync(rulesDir, { recursive: true });

  let rulesCreated = 0;
  let rulesSkipped = 0;
  for (const { name, content } of RULE_FILES) {
    const filePath = path.join(rulesDir, name);
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, "utf-8");
      if (existing === content) {
        rulesSkipped++;
        continue;
      }
    }
    fs.writeFileSync(filePath, content, "utf-8");
    rulesCreated++;
  }

  if (rulesCreated > 0) {
    console.log(chalk.green(`  Created ${rulesCreated} rule file(s) in .claude/rules/`));
  }
  if (rulesSkipped > 0) {
    console.log(chalk.dim(`  Skipped ${rulesSkipped} rule file(s) (already up to date)`));
  }

  // ── 2. Merge EDS hooks into .claude/settings.json ──────────────────────
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

  const postHooks = (hooks.PostToolUse ?? []) as Array<Record<string, unknown>>;
  let addedHooks = 0;
  for (const hook of EDS_POST_TOOL_HOOKS) {
    const cmd = hook.hooks[0].command;
    const alreadyPresent = postHooks.some((h) => {
      const nested = h.hooks as Array<{ command: string }> | undefined;
      return nested?.[0]?.command === cmd || (h.command as string) === cmd;
    });
    if (!alreadyPresent) {
      postHooks.push({ matcher: hook.matcher, hooks: hook.hooks });
      addedHooks++;
    }
  }
  hooks.PostToolUse = postHooks;

  const preHooks = (hooks.PreToolUse ?? []) as Array<Record<string, unknown>>;
  for (const hook of EDS_PRE_TOOL_HOOKS) {
    const cmd = hook.hooks[0].command;
    const alreadyPresent = preHooks.some((h) => {
      const nested = h.hooks as Array<{ command: string }> | undefined;
      return nested?.[0]?.command === cmd || (h.command as string) === cmd;
    });
    if (!alreadyPresent) {
      preHooks.push({ matcher: hook.matcher, hooks: hook.hooks });
      addedHooks++;
    }
  }
  hooks.PreToolUse = preHooks;

  settings.hooks = hooks;

  // ── 3. Merge permissions ────────────────────────────────────────────────
  const perms = (settings.permissions ?? {}) as Record<string, string[]>;
  const existingAllow = new Set(perms.allow ?? []);
  const existingDeny = new Set(perms.deny ?? []);

  for (const rule of EDS_ALLOW_PERMISSIONS) {
    existingAllow.add(rule);
  }
  for (const rule of EDS_DENY_PERMISSIONS) {
    existingDeny.add(rule);
  }

  perms.allow = [...existingAllow];
  perms.deny = [...existingDeny];
  settings.permissions = perms;

  fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  if (addedHooks > 0) {
    console.log(chalk.green(`  Added ${addedHooks} EDS hook(s) to .claude/settings.json`));
  }
  console.log(chalk.green(`  Updated .claude/settings.json (permissions: ${EDS_ALLOW_PERMISSIONS.length} allow, ${EDS_DENY_PERMISSIONS.length} deny)`));

  // ── 4. Print skill install commands and token setup ─────────────────────
  console.log(chalk.bold("\n  EDS Skills (run these manually to complete setup):"));

  console.log(chalk.dim("\n  AEM EDS skills (project-level, goes into .skills/):"));
  console.log(`    ${chalk.cyan("gh extension install ai-ecoverse/gh-upskill")}`);
  console.log(`    ${chalk.cyan("gh upskill adobe/skills --path skills/aem/edge-delivery-services --all")}`);

  console.log(chalk.dim("\n  Adobe Skills Marketplace (global, all projects):"));
  const skills = [
    ["jira-integration", "Full Jira CRUD via Python scripts"],
    ["figma-mcp",        "Extract specs and screenshots from Figma"],
    ["design-to-block",  "Figma frame + Jira ticket → milo block in one pipeline"],
    ["standup",          "Auto-generate standup from Jira + GitHub activity"],
    ["burndown",         "Sprint burndown chart from Jira"],
    ["debug-e2e",        "Analyze failed Playwright tests"],
    ["confluence-wiki",  "Create/update Confluence wiki pages"],
    ["webapp-testing",   "Playwright-based web app testing"],
    ["spacecat",         "SpaceCat API for EDS site management"],
    ["sessions",         "Search and filter past Claude Code sessions"],
  ];
  for (const [name, desc] of skills) {
    console.log(`    ${chalk.cyan(`npx skills add OneAdobe/claude-workflow -s ${name} -g`)}  ${chalk.dim(`# ${desc}`)}`);
  }

  console.log(chalk.bold("\n  API tokens:"));

  console.log(chalk.dim("\n  One-time token file setup (if not already done):"));
  console.log(`    ${chalk.cyan("touch ~/.claude-tokens && chmod 600 ~/.claude-tokens")}`);
  console.log(`    Then add to ~/.zshrc: ${chalk.cyan("source ~/.claude-tokens")}`);
  console.log(`    ${chalk.dim("(Don't put tokens directly in .zshrc — it's backed up and synced by dotfile managers)")}`);

  console.log(chalk.dim("\n  Jira token (required by jira-integration):"));
  console.log(`    1. VPN on → jira.corp.adobe.com/secure/ViewProfile.jspa`);
  console.log(`    2. Left sidebar → Personal Access Tokens → Create token (90-day max)`);
  console.log(`    3. Add to ~/.claude-tokens:`);
  console.log(`       ${chalk.cyan('export JIRA_TOKEN="<paste here>"')}`);
  console.log(`       ${chalk.cyan('export JIRA_BASE_URL="https://jira.corp.adobe.com"')}`);
  console.log(`       ${chalk.cyan('export JIRA_PROJECT="MWPW"')}  ${chalk.dim("# adjust to your project key")}`);

  console.log(chalk.dim("\n  Figma token (required by figma-mcp and design-to-block):"));
  console.log(`    1. figma.com/settings → Personal access tokens → Create`);
  console.log(`    2. Scopes: file_content:read, file_metadata:read, file_variables:read, projects:read`);
  console.log(`    3. Add to ~/.claude-tokens:`);
  console.log(`       ${chalk.cyan('export FIGMA_TOKEN="<paste here>"')}`);
  console.log(`    Note: requires a Dev or Full seat in Figma (not Viewer)`);

  console.log(chalk.dim("\n  Wiki token (required by confluence-wiki, optional):"));
  console.log(`    1. wiki.corp.adobe.com/plugins/personalaccesstokens/usertokens.action`);
  console.log(`    2. Add to ~/.claude-tokens:`);
  console.log(`       ${chalk.cyan('export WIKI_TOKEN="<paste here>"')}`);

  console.log(`\n  ${chalk.yellow("After adding tokens:")} start a new Claude Code session for them to take effect.\n`);
}
