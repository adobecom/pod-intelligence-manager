#!/usr/bin/env node
/**
 * Validate PIM access tokens without printing them.
 *
 * Reads .env, probes each provider's identity endpoint, and prints only the
 * host, HTTP status, and the resolved account — never the token value.
 *
 *   node scripts/check-tokens.mjs
 *
 * Note: git.corp.adobe.com and jira.corp.adobe.com require the Adobe VPN; an
 * "unreachable" result there usually means VPN-off rather than a bad token.
 */
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(process.cwd(), ".env");

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const env = loadEnv(ENV_PATH);
const TIMEOUT_MS = 8000;

async function probe(label, url, token, parse) {
  if (!token) return console.log(`  ${label.padEnd(26)} ·  not set`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    let who = "";
    try {
      who = parse(await res.json());
    } catch { /* non-JSON */ }
    const mark = res.ok ? "✓" : "✗";
    console.log(`  ${label.padEnd(26)} ${mark}  HTTP ${res.status}${who ? `  as ${who}` : ""}`);
  } catch (err) {
    const code = err?.name === "AbortError" ? "timeout" : (err?.cause?.code ?? err?.message ?? "error");
    console.log(`  ${label.padEnd(26)} ✗  unreachable (${code}) — VPN off?`);
  } finally {
    clearTimeout(timer);
  }
}

const jiraBase = (env.JIRA_BASE_URL || "https://jira.corp.adobe.com").replace(/\/$/, "");

console.log(`\nToken health (reading ${ENV_PATH})\n`);
await probe("GitHub  GH_TOKEN", "https://api.github.com/user", env.GH_TOKEN, (j) => j.login);
await probe("GitHub  GITHUB_TOKEN", "https://api.github.com/user", env.GITHUB_TOKEN, (j) => j.login);
await probe("gitcorp GITCORP_TOKEN", "https://git.corp.adobe.com/api/v3/user", env.GITCORP_TOKEN, (j) => j.login);
await probe("Jira    JIRA_TOKEN", `${jiraBase}/rest/api/2/myself`, env.JIRA_TOKEN, (j) => j.name || j.key || j.displayName);
console.log();
